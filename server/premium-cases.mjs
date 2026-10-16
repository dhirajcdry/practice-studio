import { groupLines, testcaseLines } from './runner/testcases.mjs';

// Match values, not example positions: mirrors can publish a different example order.
export function premiumCaseDescription(content) {
  const params = content.metaData?.params;
  if (!Array.isArray(params) || !params.length || content.metaData?.classname) return '';
  const groups = groupLines(testcaseLines(content.exampleTestcases), params.length);
  if (!groups.ok) return '';
  try {
    const examples = (content.statementExamples || []).map(({ input, output }) => {
      let rest = input.trim();
      const values = params.map(({ name }, index) => {
        if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error('unknown parameter');
        const prefix = new RegExp(`^${name}\\s*=\\s*`);
        if (!prefix.test(rest)) throw new Error('unknown input format');
        rest = rest.replace(prefix, '');
        const next = params[index + 1]?.name;
        const boundary = next ? rest.search(new RegExp(`,\\s*${next}\\s*=`)) : rest.length;
        if (boundary < 0) throw new Error('missing parameter');
        const value = JSON.parse(rest.slice(0, boundary));
        rest = next ? rest.slice(boundary + 1).trim() : '';
        return value;
      });
      return { key: JSON.stringify(values), output: JSON.stringify(JSON.parse(output)) };
    });
    const outputs = groups.cases.map(group => {
      const key = JSON.stringify(group.map(line => JSON.parse(line)));
      const matches = examples.filter(example => example.key === key);
      if (!matches.length || matches.some(m => m.output !== matches[0].output)) throw new Error('unmatched example');
      return matches[0].output;
    });
    return outputs.map(output => `<pre><strong>Output:</strong> ${output.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`).join('');
  } catch {
    // Ambiguous or non-JSON examples keep their unpublished expected values.
    return '';
  }
}
