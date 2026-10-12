// A stand-in for autokaraoke's separator: writes one short vocal WAV and never starts Python.
// OPENKARAOKE_FAKE_STEMS=1 (or a test that passes this function) uses it.
import { writePcmWav } from './wav.js';

export async function fakeStemRun({ vocal }) {
  await writePcmWav(vocal, { hz: 880, seconds: 2 });
}
