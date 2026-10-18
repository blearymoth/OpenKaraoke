// A stand-in for autokaraoke's separator: writes a short vocal (880 Hz) and music (220 Hz) WAV and
// never starts Python. OPENKARAOKE_FAKE_STEMS=1 (or a test that passes this function) uses it.
import { writePcmWav } from './wav.js';

export async function fakeStemRun({ vocal, music, seconds = 2 }) {
  if (music) await writePcmWav(music, { hz: 220, seconds });
  await writePcmWav(vocal, { hz: 880, seconds });
}
