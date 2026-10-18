#!/usr/bin/env python3
import base64, io, json, os, sys

def main():
    model = os.environ.get('STUDIO_TTS_MODEL')
    voices = os.environ.get('STUDIO_TTS_VOICES')
    try:
        from kokoro_onnx import Kokoro
        import soundfile as sf
        if not model or not voices:
            raise RuntimeError('TTS model files are not configured')
        engine = Kokoro(model, voices)
        available = engine.get_voices()
        for line in sys.stdin:
            try:
                req = json.loads(line)
                if req.get('op') == 'voices':
                    print(json.dumps({'ok': True, 'voices': available}), flush=True); continue
                text = str(req.get('text', ''))
                voice = str(req.get('voice') or 'af_heart')
                speed = float(req.get('speed', 1.0))
                samples, rate = engine.create(text, voice=voice, speed=speed, lang='en-gb' if voice.startswith('b') else 'en-us')
                out = io.BytesIO(); sf.write(out, samples, rate, format='WAV', subtype='PCM_16')
                print(json.dumps({'ok': True, 'wav': base64.b64encode(out.getvalue()).decode('ascii'), 'voice': voice}), flush=True)
            except Exception as e:
                print(json.dumps({'ok': False, 'error': {'kind': 'synthesis', 'message': str(e)}}), flush=True)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': {'kind': 'unavailable', 'message': str(e)}}), flush=True)
        return 1
    return 0
if __name__ == '__main__': sys.exit(main())
