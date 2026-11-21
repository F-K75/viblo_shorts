import path from 'node:path';

/**
 * A lavfi audio source of REAL speech (ffmpeg's flite voice reading the test talk), looped to `durS` seconds at 48 kHz.
 * E2E fixtures used to stand in for a speaker with a 440 Hz tone; the quality gate now checks that speech is speech,
 * so a tone is (correctly) reported as "no voice heard".
 */
export function speechLavfi(durS: number, voice = 'slt'): string {
  const text = path.resolve(import.meta.dirname, '../fixtures/talk.txt');
  return `flite=textfile='${text}':voice=${voice},aloop=loop=-1:size=2147483647,atrim=0:${durS},aresample=48000`;
}
