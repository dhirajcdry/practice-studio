# Studio local runner — the driver.
#
# Copied verbatim into a fresh temp dir next to the user's `solution.py`, then run once per
# test case. It is deliberately config-driven rather than generated, so there is exactly one
# driver file, with exactly one name, for the traceback rewriter to hide.
#
# Contract with the parent process:
#   env STUDIO_CONFIG  path to JSON: {kind, name|classname, args|ops/opArgs}
#   env STUDIO_RESULT  path to write the result envelope to (atomically)
#   env STUDIO_PHASE   "probe" (import only) or "run"
#   the user's own prints go to real stdout; the parent captures and caps them.
#
# Exit codes: 0 fine, 3 the user's code raised, 4 the driver itself broke.

import json
import os
import re
import sys
import time
import traceback
from collections import deque

RESULT = os.environ["STUDIO_RESULT"]
PHASE = os.environ.get("STUDIO_PHASE", "run")


def write_result(obj):
    tmp = RESULT + ".part"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, RESULT)


def apply_limits():
    """Belt and braces against an accidental runaway. Best effort: several of these are
    not enforced on macOS, and the parent's timeout + process-group kill is the real
    backstop."""
    try:
        import resource
    except Exception:
        return
    mb = 1024 * 1024
    for name, limit in (
        ("RLIMIT_AS", 2048 * mb),
        ("RLIMIT_DATA", 2048 * mb),
        ("RLIMIT_FSIZE", 64 * mb),
        ("RLIMIT_CORE", 0),
    ):
        res = getattr(resource, name, None)
        if res is None:
            continue
        try:
            soft, hard = resource.getrlimit(res)
            new = limit if hard in (resource.RLIM_INFINITY, -1) else min(limit, hard)
            resource.setrlimit(res, (new, hard))
        except Exception:
            pass


def disable_network():
    """No network for the child. On macOS the parent also wraps us in sandbox-exec with
    `(deny network*)`; this is the portable half."""

    def blocked(*_a, **_k):
        raise OSError("Network access is disabled while running your code locally.")

    try:
        import socket

        socket.socket = blocked
        socket.create_connection = blocked
        socket.create_server = blocked
        socket.socketpair = blocked
        socket.getaddrinfo = blocked
    except Exception:
        pass


class Unserializable(Exception):
    pass


def encode(value, depth=0):
    if depth > 60:
        raise Unserializable("nested too deeply")
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return repr(value)
        return value
    if isinstance(value, (list, tuple)):
        return [encode(v, depth + 1) for v in value]
    if isinstance(value, dict):
        return {str(k): encode(v, depth + 1) for k, v in value.items()}
    raise Unserializable(type(value).__name__)


# --------------------------------------------------------------------------- nodes
#
# LeetCode prints a linked list as the array of its values and a binary tree as its
# level-order array with `null` for a missing child. The judge builds the real object
# before calling you and flattens whatever you return before printing it. So do we: the
# array in the test case box is the array LeetCode shows, and the array in the result is
# the array LeetCode would have shown.
#
# Everything here is bounded. A solution with a pointer bug can return a list that loops
# back on itself, and following that is a hang, not an answer — so every walk carries a
# visited set and a ceiling, and says plainly what it found instead of spinning.

MAX_NODES = 100000


class BadNode(Exception):
    """The value cannot be read as the node type the signature promised."""


def split_type(raw):
    """('ListNode', 1) for `list<ListNode>` or `ListNode[]`. Mirrors baseTypeOf in meta.mjs."""
    text = str(raw or "").strip()
    depth = 0
    for _ in range(16):
        inner = re.match(r"^[Ll]ist<(.+)>$", text)
        if inner:
            text = inner.group(1).strip()
            depth += 1
            continue
        if text.endswith("[]"):
            text = text[:-2].strip()
            depth += 1
            continue
        break
    return text, depth


def node_kind(raw):
    """'listnode', 'treenode', or None for anything we pass through untouched."""
    base, _ = split_type(raw)
    base = base.lower()
    return base if base in ("listnode", "treenode") else None


def node_classes(user_module):
    """Prefer the class the user defined, so `isinstance` checks in their code hold.

    LeetCode's stubs carry a commented-out ListNode/TreeNode and plenty of people
    uncomment it. Building our own class instead would leave their `isinstance(node,
    ListNode)` false against an object that is a ListNode in every way that matters.
    """
    import builtins

    out = {}
    for name in ("ListNode", "TreeNode"):
        cls = getattr(user_module, name, None)
        if not isinstance(cls, type):
            cls = getattr(builtins, name, None)
        out[name] = cls
    return out


def make_node(cls, val, fields):
    """One node, with its links cleared. LeetCode's stub has defaults; an older or
    hand-written one may take only `val`, so the links are set rather than passed."""
    try:
        node = cls(val)
    except TypeError:
        node = cls()
        node.val = val
    for field in fields:
        setattr(node, field, None)
    return node


def build_list(values, cls):
    if values is None:
        return None
    if not isinstance(values, list):
        raise BadNode("A linked list case is written as an array of its values, like [1,2,3].")
    head = None
    tail = None
    for value in values:
        node = make_node(cls, value, ("next",))
        if head is None:
            head = node
        else:
            tail.next = node
        tail = node
    return head


def build_tree(values, cls):
    """Level order with `null` for a missing child — LeetCode's own format."""
    if values is None:
        return None
    if not isinstance(values, list):
        raise BadNode("A tree case is written as its level-order array, like [1,null,2,3].")
    if not values or values[0] is None:
        return None
    root = make_node(cls, values[0], ("left", "right"))
    queue = deque([root])
    i = 1
    while queue and i < len(values):
        node = queue.popleft()
        for side in ("left", "right"):
            if i >= len(values):
                break
            value = values[i]
            i += 1
            if value is None:
                continue
            child = make_node(cls, value, ("left", "right"))
            setattr(node, side, child)
            queue.append(child)
    return root


def build_arg(value, type_str, classes):
    kind = node_kind(type_str)
    if kind is None:
        return value
    _, depth = split_type(type_str)
    cls = classes["ListNode" if kind == "listnode" else "TreeNode"]
    if cls is None:
        raise BadNode("The node class for this problem is not available.")

    def build(v, left):
        if left > 0:
            if v is None:
                return None
            if not isinstance(v, list):
                raise BadNode("This case should be a list of node arrays.")
            return [build(item, left - 1) for item in v]
        return build_list(v, cls) if kind == "listnode" else build_tree(v, cls)

    return build(value, depth)


def list_to_array(head):
    out = []
    seen = set()
    node = head
    while node is not None:
        if id(node) in seen:
            raise BadNode(
                "Your code returned a linked list that loops back on itself, so following it "
                "never ends and there is nothing to compare."
            )
        if len(out) >= MAX_NODES:
            raise BadNode(
                "Your code returned a linked list longer than %d nodes, which is more than "
                "this problem can have — it is probably looping." % MAX_NODES
            )
        if not hasattr(node, "val"):
            raise BadNode(
                "This problem returns a ListNode and your code returned a %s."
                % type(node).__name__
            )
        seen.add(id(node))
        out.append(encode(node.val))
        node = getattr(node, "next", None)
    return out


def tree_to_array(root):
    """Level order, trailing nulls trimmed — exactly how LeetCode prints a tree."""
    if root is None:
        return []
    out = []
    seen = set()
    queue = deque([root])
    while queue:
        node = queue.popleft()
        if node is None:
            out.append(None)
            continue
        if not hasattr(node, "val"):
            raise BadNode(
                "This problem returns a TreeNode and your code returned a %s."
                % type(node).__name__
            )
        if id(node) in seen:
            raise BadNode(
                "Your code returned a tree that points back at one of its own nodes, so "
                "walking it never ends and there is nothing to compare."
            )
        if len(seen) >= MAX_NODES:
            raise BadNode(
                "Your code returned a tree of more than %d nodes, which is more than this "
                "problem can have — it is probably looping." % MAX_NODES
            )
        seen.add(id(node))
        out.append(encode(node.val))
        queue.append(getattr(node, "left", None))
        queue.append(getattr(node, "right", None))
    while out and out[-1] is None:
        out.pop()
    return out


def encode_return(value, type_str):
    kind = node_kind(type_str)
    if kind is None:
        return encode(value)
    _, depth = split_type(type_str)

    def flatten(v, left):
        if left > 0:
            if v is None:
                return None
            return [flatten(item, left - 1) for item in v]
        return list_to_array(v) if kind == "listnode" else tree_to_array(v)

    return flatten(value, depth)


# --------------------------------------------------------------------- adapters
#
# The handful of problems whose printed example is not their argument list. LeetCode's
# judge builds something first — a cycle, a graph, an API object, a `guess()` — and
# metaData describes that input rather than the call. One function each, below, doing
# exactly what LeetCode's own driver does for that problem and nothing more.
#
# Every one of these is reached only after adapters.mjs has matched a fingerprint of the
# problem's metaData, so none of them can be pointed at a problem it was not written for.


def user_class(user_module, name, fallback):
    """The user's own class if they defined one, else ours.

    People uncomment the class LeetCode leaves in the stub. Building our own beside theirs
    would leave their `isinstance(x, Node)` false against an object that is a Node in every
    way that matters.
    """
    cls = getattr(user_module, name, None)
    return cls if isinstance(cls, type) else fallback


def make_random_node_class():
    class Node:
        def __init__(self, x, next=None, random=None):
            self.val = int(x)
            self.next = next
            self.random = random
    return Node


def make_graph_node_class():
    class Node:
        def __init__(self, val=0, neighbors=None):
            self.val = val
            self.neighbors = neighbors if neighbors is not None else []
    return Node


def make_quad_node_class():
    class Node:
        def __init__(self, val, isLeaf, topLeft, topRight, bottomLeft, bottomRight):
            self.val = val
            self.isLeaf = isLeaf
            self.topLeft = topLeft
            self.topRight = topRight
            self.bottomLeft = bottomLeft
            self.bottomRight = bottomRight
    return Node


def default_node_class(driver):
    """The `Node` this problem's stub describes — three different classes share the name."""
    if driver == "random-list":
        return make_random_node_class()
    if driver == "graph":
        return make_graph_node_class()
    if driver == "quad-tree":
        return make_quad_node_class()
    return None


def list_nodes(head):
    """Every node of a linked list, in order, refusing to walk a cycle forever."""
    out = []
    seen = set()
    node = head
    while node is not None:
        if id(node) in seen or len(out) >= MAX_NODES:
            raise BadNode(
                "Your code returned a linked list that loops back on itself, so following it "
                "never ends and there is nothing to compare."
            )
        seen.add(id(node))
        out.append(node)
        node = getattr(node, "next", None)
    return out


def tie_cycle(values, pos, cls):
    """LeetCode's setup for the cycle problems: build the list, then point the tail at
    node `pos`. A negative pos means no cycle."""
    head = build_list(values, cls)
    nodes = list_nodes(head)
    if not nodes:
        return head, nodes
    if isinstance(pos, int) and not isinstance(pos, bool) and 0 <= pos < len(nodes):
        nodes[-1].next = nodes[pos]
    return head, nodes


def find_by_value(root, wanted):
    """The node holding this value, which is what the judge passes for p and q."""
    queue = deque([root])
    while queue:
        node = queue.popleft()
        if node is None:
            continue
        if getattr(node, "val", None) == wanted:
            return node
        queue.append(getattr(node, "left", None))
        queue.append(getattr(node, "right", None))
    return None


def random_list_to_array(head):
    """[[value, index the random pointer goes to], ...] — LeetCode's own printed form."""
    nodes = list_nodes(head)
    where = {id(n): i for i, n in enumerate(nodes)}
    out = []
    for node in nodes:
        target = getattr(node, "random", None)
        out.append([
            encode(getattr(node, "val", None)),
            None if target is None else where.get(id(target)),
        ])
    return out


def graph_nodes(node):
    """Every node reachable from here, keyed by value. Values are unique per the problem."""
    found = {}
    stack = [node]
    while stack:
        current = stack.pop()
        if current is None:
            continue
        value = getattr(current, "val", None)
        if value in found:
            continue
        if len(found) >= MAX_NODES:
            raise BadNode("Your code returned a graph larger than this problem can have.")
        found[value] = current
        for neighbour in (getattr(current, "neighbors", None) or []):
            stack.append(neighbour)
    return found


def graph_to_array(node):
    """The adjacency list LeetCode prints: node 1's neighbours, then node 2's, ..."""
    if node is None:
        return []
    found = graph_nodes(node)
    out = []
    for value in sorted(found):
        neighbours = getattr(found[value], "neighbors", None) or []
        # Sorted because a set of neighbours has no order, and the printed form is sorted.
        out.append(sorted(encode(getattr(n, "val", None)) for n in neighbours))
    return out


def quad_to_array(root):
    """Level order, four slots per node, [isLeaf, val] each, trailing nulls trimmed.

    A non-leaf's value is flattened to 1: the statement says outright that either value is
    acceptable there, so comparing it would fail correct answers.
    """
    if root is None:
        return []
    out = []
    seen = set()
    queue = deque([root])
    while queue:
        node = queue.popleft()
        if node is None:
            out.append(None)
            continue
        if id(node) in seen or len(seen) >= MAX_NODES:
            raise BadNode("Your code returned a quad tree that points back at one of its own nodes.")
        seen.add(id(node))
        leaf = 1 if getattr(node, "isLeaf", False) else 0
        out.append([leaf, (1 if getattr(node, "val", False) else 0) if leaf else 1])
        for side in ("topLeft", "topRight", "bottomLeft", "bottomRight"):
            queue.append(getattr(node, side, None))
    while out and out[-1] is None:
        out.pop()
    return out


def require_copy(original_ids, produced, what):
    """A "copy" that hands back the objects it was given is not a copy.

    Without this, `return head` passes copy-list-with-random-pointer and `return node`
    passes clone-graph. LeetCode's judge checks the same thing; so must we, or the run
    would be reporting a pass for the one solution the problem exists to rule out.
    """
    for node in produced:
        if id(node) in original_ids:
            raise BadNode(
                "Your code returned the original %s rather than a copy of it — at least one "
                "node is the same object that was passed in." % what
            )


class MountainArray:
    """LeetCode's own API object, including its budget.

    metaData ships this class; the 100-call limit is part of the problem, and a solution
    that scans the whole array is meant to fail on it.
    """

    LIMIT = 100

    def __init__(self, secret):
        self._secret = list(secret)
        self._calls = 0

    def get(self, index):
        self._calls += 1
        if self._calls > self.LIMIT:
            raise BadNode(
                "Your code called MountainArray.get more than %d times, which this problem "
                "does not allow." % self.LIMIT
            )
        return self._secret[index]

    def length(self):
        return len(self._secret)

    def calls(self):
        return self._calls


def run_adapter(driver, cfg, user_module, target, values, classes, notes=None):
    """One case, for a problem whose input needed building first.

    @param notes a dict the recipe may put an `info` string into, for something worth
                 saying about the run that is not a verdict.
    @returns the answer already in the form LeetCode prints it.
    """
    if notes is None:
        notes = {}
    def call(*passed):
        """A fresh Solution per case, exactly as the generic path does it."""
        return getattr(target(), cfg["name"])(*passed)

    if driver in ("cycle-list",):
        head, nodes = tie_cycle(values[0], values[1], classes["ListNode"])
        answer = call(head)
        if (cfg.get("adapter") or {}).get("answer") == "node-index":
            if answer is None:
                return None
            where = {id(n): i for i, n in enumerate(nodes)}
            return where.get(id(answer))
        return encode(answer)

    if driver == "guess-number":
        import builtins

        pick = values[1]

        def guess(num):
            # metaData ships the judge's own: 0 when equal, -1 when the guess is too high.
            if num == pick:
                return 0
            return -1 if num > pick else 1

        previous = getattr(builtins, "guess", None)
        builtins.guess = guess
        try:
            return encode(call(values[0]))
        finally:
            if previous is None:
                delattr(builtins, "guess")
            else:
                builtins.guess = previous

    if driver == "random-list":
        cls = classes["Node"]
        entries = values[0] or []
        if not isinstance(entries, list):
            raise BadNode("This case should be a list of [value, random index] pairs.")
        nodes = [cls(entry[0] if isinstance(entry, list) else entry) for entry in entries]
        for i, node in enumerate(nodes):
            node.next = nodes[i + 1] if i + 1 < len(nodes) else None
            target_index = entries[i][1] if isinstance(entries[i], list) and len(entries[i]) > 1 else None
            node.random = nodes[target_index] if isinstance(target_index, int) else None
        head = nodes[0] if nodes else None
        answer = call(head)
        produced = list_nodes(answer)
        require_copy({id(n) for n in nodes}, produced, "list")
        return random_list_to_array(answer)

    if driver == "graph":
        cls = classes["Node"]
        adjacency = values[0] or []
        nodes = [cls(i + 1) for i in range(len(adjacency))]
        for i, neighbours in enumerate(adjacency):
            nodes[i].neighbors = [nodes[j - 1] for j in (neighbours or []) if 1 <= j <= len(nodes)]
        first = nodes[0] if nodes else None
        answer = call(first)
        if first is not None:
            require_copy({id(n) for n in nodes}, graph_nodes(answer).values(), "graph")
        return graph_to_array(answer)

    if driver == "quad-tree":
        return quad_to_array(call(values[0]))

    if driver == "lca":
        root = build_tree(values[0], classes["TreeNode"])
        p = find_by_value(root, values[1])
        q = find_by_value(root, values[2])
        if p is None or q is None:
            raise BadNode(
                "This case names a value that is not in the tree, and the judge looks both "
                "values up as nodes before calling you."
            )
        answer = call(root, p, q)
        return None if answer is None else encode(getattr(answer, "val", None))

    if driver == "mountain-array":
        # The stub takes (target, mountainArr); metaData lists them the other way round.
        arr = MountainArray(values[0] or [])
        answer = encode(call(values[1], arr))
        # The call budget IS this problem. LeetCode's published examples are 6 and 7
        # elements long, so a linear scan stays under the limit and passes them — on
        # LeetCode too. Saying how close it came is the honest way to show that.
        notes["info"] = "Used %d of the %d allowed MountainArray.get calls." % (
            arr.calls(),
            MountainArray.LIMIT,
        )
        return answer

    if driver == "codec-tree":
        root = build_tree(values[0], classes["TreeNode"])
        # Two instances, as the stub's own footer spells out — a Codec that stashed the
        # tree on `self` would otherwise round-trip through memory instead of its string.
        encoded = target().serialize(root)
        return tree_to_array(target().deserialize(encoded))

    if driver == "codec-strings":
        encoded = target().encode(values[0])
        return encode(target().decode(encoded))

    if driver == "intersection":
        cls = classes["ListNode"]
        intersect_val, list_a, list_b, skip_a, skip_b = values[0], values[1], values[2], values[3], values[4]
        head_a = build_list(list_a, cls)
        nodes_a = list_nodes(head_a)
        if intersect_val == 0 or skip_a >= len(nodes_a):
            head_b = build_list(list_b, cls)
        else:
            shared = nodes_a[skip_a]
            prefix = list(list_b or [])[:skip_b]
            head_b = build_list(prefix, cls)
            tail = list_nodes(head_b)
            if tail:
                tail[-1].next = shared
            else:
                head_b = shared
        answer = call(head_a, head_b)
        return None if answer is None else encode(getattr(answer, "val", None))

    raise BadNode("The local runner has no recipe named %s." % driver)


def safe_repr(value, limit=2000):
    try:
        text = repr(value)
    except Exception:
        return "<un-representable object>"
    return text if len(text) <= limit else text[:limit] + "…"


def install_leetcode_namespace(adapter_driver=None):
    """Make the user's file import under the same names LeetCode's judge provides.

    LeetCode's Python stubs are annotated `def twoSum(self, nums: List[int]) -> List[int]`
    with no import in sight, because their judge pre-imports typing. Annotations are
    evaluated when the `def` executes, so a bare interpreter raises NameError at import
    time and *no test case ever runs* — which looks like the user's code is broken when it
    is actually ours.

    These go into `builtins` rather than being prepended to solution.py on purpose: adding
    lines would shift every line number, and the traceback rewriter's whole job is to point
    at the line the user is looking at in the editor.
    """
    import builtins
    import collections

    names = {}

    import typing
    for name in (
        "List", "Dict", "Set", "FrozenSet", "Tuple", "Optional", "Union", "Any",
        "Callable", "Iterable", "Iterator", "Sequence", "Mapping", "MutableMapping",
        "Deque", "DefaultDict", "Counter", "OrderedDict", "Generator", "TypeVar",
        "Generic", "NamedTuple", "Text", "NoReturn", "Final", "Literal",
    ):
        value = getattr(typing, name, None)
        if value is not None:
            names[name] = value

    # LeetCode also has these in scope without an import.
    names.setdefault("defaultdict", collections.defaultdict)
    names.setdefault("deque", collections.deque)

    # The node classes LeetCode defines for linked-list and tree problems. LeetCode's stub
    # has them commented out, so a solution that mentions ListNode without uncommenting it
    # would otherwise be a NameError. If the user DID define their own, theirs wins — see
    # node_classes() — and these are never reached.
    if not hasattr(builtins, "ListNode"):
        class ListNode:
            def __init__(self, val=0, next=None):
                self.val = val
                self.next = next
        names["ListNode"] = ListNode

    if not hasattr(builtins, "TreeNode"):
        class TreeNode:
            def __init__(self, val=0, left=None, right=None):
                self.val = val
                self.left = left
                self.right = right
        names["TreeNode"] = TreeNode

    # `Node` is three different classes across three problem families, so it is installed
    # only when we know which problem this is — and only the one that problem's own stub
    # describes. See default_node_class.
    if adapter_driver is not None and not hasattr(builtins, "Node"):
        node_cls = default_node_class(adapter_driver)
        if node_cls is not None:
            names["Node"] = node_cls

    for name, value in names.items():
        if not hasattr(builtins, name):
            setattr(builtins, name, value)


def explain_missing_module(exc):
    """Turn a bare ImportError into something that says what to do about it.

    LeetCode's judge ships a few third-party packages we do not have locally. Hitting one
    should say so plainly rather than looking like the user's own broken import.
    """
    missing = getattr(exc, "name", None) or ""
    known = {
        "sortedcontainers": (
            "`sortedcontainers` (SortedList / SortedDict) is available on LeetCode's judge "
            "but is not installed here, so this solution cannot run locally. Submitting it "
            "on LeetCode is unaffected. To run it here: pip3 install sortedcontainers"
        ),
        "numpy": (
            "`numpy` is not installed here. LeetCode's judge has it; local runs do not. "
            "Submitting is unaffected."
        ),
    }
    return known.get(missing)


def main():
    apply_limits()
    disable_network()

    with open(os.environ["STUDIO_CONFIG"], "r", encoding="utf-8") as fh:
        cfg = json.load(fh)

    adapter = cfg.get("adapter") or None
    # Read before the import, because which `Node` class to put in scope depends on which
    # problem this is.
    install_leetcode_namespace(adapter.get("driver") if adapter else None)

    # --- import the user's file ------------------------------------------------------
    try:
        import solution as user_module
    except BaseException:
        exc = sys.exc_info()[1]
        hint = explain_missing_module(exc) if isinstance(exc, ImportError) else None
        write_result(
            {
                "phase": "import",
                "status": "error",
                "traceback": traceback.format_exc(),
                "errorType": type(exc).__name__,
                "message": hint or str(exc),
                "hint": hint,
            }
        )
        return 3

    target_name = cfg.get("classname") or "Solution"
    target = getattr(user_module, target_name, None)
    if target is None:
        write_result(
            {
                "phase": "import",
                "status": "error",
                "errorType": "NameError",
                "message": "Your code does not define a class named %s." % target_name,
                "traceback": "",
            }
        )
        return 3

    if cfg["kind"] == "function":
        for method_name in (cfg.get("methods") or [cfg["name"]]):
            if not hasattr(target, method_name):
                write_result(
                    {
                        "phase": "import",
                        "status": "error",
                        "errorType": "AttributeError",
                        "message": "Your %s class does not define a method named %s."
                        % (target_name, method_name),
                        "traceback": "",
                    }
                )
                return 3

    if PHASE == "probe":
        write_result({"phase": "probe", "status": "ok"})
        return 0

    # --- build the arguments ---------------------------------------------------------
    # Before the clock starts: turning [1,2,3] into a linked list is our work, not the
    # user's, and it must not show up in the timing of their solution.
    args = cfg.get("args") or []
    classes = node_classes(user_module)
    if adapter:
        # The recipe builds its own input: the values are the judge's setup, not the
        # arguments, so the generic builder would build the wrong thing from them.
        classes["Node"] = user_class(user_module, "Node", default_node_class(adapter["driver"]))
    elif cfg["kind"] == "function":
        arg_types = cfg.get("argTypes") or []
        try:
            args = [
                build_arg(value, arg_types[i] if i < len(arg_types) else None, classes)
                for i, value in enumerate(args)
            ]
        except BadNode as err:
            write_result(
                {
                    "phase": "run",
                    "status": "bad-input",
                    "message": str(err),
                }
            )
            return 0

    # --- run one case ----------------------------------------------------------------
    if adapter:
        started = time.perf_counter()
        notes = {}
        try:
            answer = run_adapter(adapter["driver"], cfg, user_module, target, args, classes, notes)
        except BadNode as err:
            write_result({"phase": "run", "status": "bad-input", "message": str(err)})
            return 0
        except BaseException:
            elapsed = (time.perf_counter() - started) * 1000.0
            exc = sys.exc_info()[1]
            write_result(
                {
                    "phase": "run",
                    "status": "error",
                    "ms": elapsed,
                    "traceback": traceback.format_exc(),
                    "errorType": type(exc).__name__,
                    "message": str(exc),
                }
            )
            return 3
        elapsed = (time.perf_counter() - started) * 1000.0
        try:
            encoded = encode(answer)
        except Unserializable as err:
            write_result(
                {
                    "phase": "run",
                    "status": "unserializable",
                    "ms": elapsed,
                    "repr": safe_repr(answer),
                    "message": "Your code returned a %s, which cannot be compared automatically." % err,
                }
            )
            return 0
        write_result(
            {
                "phase": "run",
                "status": "ok",
                "ms": elapsed,
                "value": encoded,
                **({"info": notes["info"]} if notes.get("info") else {}),
            }
        )
        return 0

    started = time.perf_counter()
    try:
        if cfg["kind"] == "function":
            value = getattr(target(), cfg["name"])(*args)
        else:
            value = run_design(target, cfg)
    except BaseException:
        elapsed = (time.perf_counter() - started) * 1000.0
        exc = sys.exc_info()[1]
        write_result(
            {
                "phase": "run",
                "status": "error",
                "ms": elapsed,
                "traceback": traceback.format_exc(),
                "errorType": type(exc).__name__,
                "message": str(exc),
            }
        )
        return 3
    elapsed = (time.perf_counter() - started) * 1000.0

    # An in-place problem's answer is the argument it mutated, not what it returned.
    # metaData names the argument; `size: "ret"` means only the first N of it count, where
    # N is the value returned. This is LeetCode's own rule, not an inference.
    answer_type = cfg.get("returnType")
    answer_from = cfg.get("answerFrom") if cfg["kind"] == "function" else None
    if answer_from:
        index = answer_from.get("paramIndex", 0)
        answer = args[index] if index < len(args) else None
        if answer_from.get("sizeFromReturn"):
            size = value if isinstance(value, int) and not isinstance(value, bool) else 0
            answer = list(answer or [])[: max(0, size)]
        value = answer
        arg_types = cfg.get("argTypes") or []
        answer_type = arg_types[index] if index < len(arg_types) else None

    try:
        encoded = (
            encode_return(value, answer_type)
            if cfg["kind"] == "function"
            else encode(value)
        )
    except BadNode as err:
        write_result(
            {
                "phase": "run",
                "status": "unserializable",
                "ms": elapsed,
                "repr": safe_repr(value),
                "message": str(err),
            }
        )
        return 0
    except Unserializable as err:
        write_result(
            {
                "phase": "run",
                "status": "unserializable",
                "ms": elapsed,
                "repr": safe_repr(value),
                "message": "Your code returned a %s, which cannot be compared automatically." % err,
            }
        )
        return 0

    write_result({"phase": "run", "status": "ok", "ms": elapsed, "value": encoded})
    return 0


def run_design(cls, cfg):
    """Constructor + operation sequence. Slot 0 is the constructor and its result is
    always null, which is how LeetCode prints these."""
    ops = cfg["ops"]
    args = cfg["opArgs"]
    out = []
    instance = None
    for i, name in enumerate(ops):
        call_args = args[i] if i < len(args) else []
        if i == 0:
            instance = cls(*call_args)
            out.append(None)
            continue
        method = getattr(instance, name, None)
        if method is None:
            raise AttributeError("Your %s class does not define a method named %s." % (cfg["classname"], name))
        out.append(method(*call_args))
    return out


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:
        # The driver itself broke. Say so honestly rather than blaming the user's code.
        try:
            write_result(
                {
                    "phase": "driver",
                    "status": "driver-error",
                    "traceback": traceback.format_exc(),
                }
            )
        except Exception:
            sys.stderr.write(traceback.format_exc())
        sys.exit(4)
