// The rules for the progress bars, with a fake clock. Usage: node test/progress.mjs
import { createPacer, predictMs } from '../ui/progress.js';

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

const settings = { convert: 'keep' };
const file = (kb, name = 'a.jpg') => ({ size: kb * 1024, name, type: '' });
const jobs = (...sizes) => sizes.map((kb, id) => ({ id, file: file(kb) }));

// Runs the clock from `from`, returning the values seen. Ticks are 100 ms, like the page.
function run(pacer, from, to, read) {
  const seen = [];
  for (let at = from + 100; at <= to; at += 100) {
    pacer.tick(at);
    seen.push(read());
  }
  return seen;
}
const rising = (values) => values.every((v, i) => i === 0 || v >= values[i - 1]);

{
  const items = jobs(1000);
  const predicted = predictMs(items[0].file, settings);
  const pacer = createPacer(items, settings, 1, 0);
  pacer.start(0, 0);
  const seen = run(pacer, 0, predicted * 2, () => pacer.value(0));
  const halfway = seen[Math.round(predicted / 200)];
  check('moves evenly when the estimate is right', Math.abs(halfway - 0.5) < 0.03, `halfway ${halfway.toFixed(3)}`);
  check('never goes backwards', rising(seen));
  check('reaches the end by the estimate', seen[Math.ceil(predicted / 100)] === 1);
  check('waits at the end when it runs longer', seen.at(-1) === 1);
}

{
  const items = jobs(1000);
  const predicted = predictMs(items[0].file, settings);
  const pacer = createPacer(items, settings, 1, 0);
  pacer.start(0, 0);
  const before = run(pacer, 0, predicted / 2, () => pacer.value(0));
  pacer.scored(8000); // This device turns out four times slower than the reference.
  const after = run(pacer, predicted / 2, predicted, () => pacer.value(0));
  const steady = before.at(-1) - before.at(-2);
  const slower = after[1] - after[0];
  check('a longer estimate slows the bar', slower > 0 && slower < steady * 0.8, `${steady.toFixed(4)} per tick, then ${slower.toFixed(4)}`);
  check('and it does not jump back', after[0] >= before.at(-1) && rising(after));
  check('and it has not reached the end', after.at(-1) < 1, after.at(-1).toFixed(3));
}

{
  const items = jobs(1000, 1000, 1000, 1000);
  const predicted = predictMs(items[0].file, settings);
  const pacer = createPacer(items, settings, 2, 0);
  pacer.start(0, 0);
  pacer.start(1, 0);
  const first = run(pacer, 0, predicted, () => pacer.batch);
  check('two workers finish four files in two rounds', Math.abs(first.at(-1) - 0.5) < 0.05, first.at(-1).toFixed(3));
  pacer.finish(0, predicted * 3); // Took three times the estimate.
  pacer.finish(1, predicted * 3);
  pacer.start(2, predicted * 3);
  pacer.start(3, predicted * 3);
  const second = run(pacer, predicted * 3, predicted * 3 + predicted, () => pacer.batch);
  check('later files inherit the measured speed', second.at(-1) < 1, second.at(-1).toFixed(3));
  check('the batch bar never goes backwards', rising([...first, ...second]));
}

{
  const pacer = createPacer(jobs(1000), settings, 1, 0);
  pacer.start(0, 0);
  pacer.tick(100);
  pacer.tick(60000); // A hidden tab slows timers, so the next tick can come late.
  check('a late tick stays in range', pacer.value(0) === 1 && pacer.batch === 1);
}

console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exitCode = failed ? 1 : 0;
