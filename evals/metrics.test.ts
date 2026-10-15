import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  accuracy,
  addCounts,
  binaryCounts,
  classCounts,
  compareToBaseline,
  confusion,
  f1,
  macroF1,
  matchByOverlap,
  prf,
  rate,
  round,
  scoreField,
  tally,
  zeroTally,
  type Baseline,
} from './metrics.ts';

const close = (actual: number, expected: number, msg?: string) => assert.ok(Math.abs(actual - expected) < 1e-9, msg ?? `${actual} != ${expected}`);

describe('prf', () => {
  it('computes precision, recall and F1 from counts', () => {
    const r = prf({ tp: 6, fp: 2, fn: 4 });
    close(r.precision, 0.75);
    close(r.recall, 0.6);
    close(r.f1, (2 * 0.75 * 0.6) / 1.35);
  });

  it('scores an empty slice (nothing to find, nothing predicted) as perfect', () => {
    assert.deepEqual(prf({ tp: 0, fp: 0, fn: 0 }), { precision: 1, recall: 1, f1: 1 });
  });

  it('gives a detector that predicts nothing zero precision, not a free 1', () => {
    assert.deepEqual(prf({ tp: 0, fp: 0, fn: 3 }), { precision: 0, recall: 0, f1: 0 });
  });

  it('gives zero recall when there was nothing to find but something was predicted', () => {
    assert.deepEqual(prf({ tp: 0, fp: 2, fn: 0 }), { precision: 0, recall: 0, f1: 0 });
  });

  it('adds counts', () => {
    assert.deepEqual(addCounts({ tp: 1, fp: 2, fn: 3 }, { tp: 4, fp: 5, fn: 6 }), { tp: 5, fp: 7, fn: 9 });
  });

  it('f1 is the harmonic mean and 0 when both inputs are 0', () => {
    close(f1(1, 0.5), 2 / 3);
    assert.equal(f1(0, 0), 0);
  });
});

describe('confusion matrix', () => {
  const labels = ['a', 'b', 'none'] as const;
  const m = confusion(labels, [
    ['a', 'a'],
    ['a', 'a'],
    ['a', 'b'],
    ['b', 'b'],
    ['b', 'none'],
    ['none', 'none'],
    ['none', 'a'],
  ]);

  it('counts gold-by-predicted, with every label present', () => {
    assert.deepEqual(m.a, { a: 2, b: 1, none: 0 });
    assert.deepEqual(m.b, { a: 0, b: 1, none: 1 });
    assert.deepEqual(m.none, { a: 1, b: 0, none: 1 });
  });

  it('derives one-vs-rest counts per class', () => {
    assert.deepEqual(classCounts(m, 'a'), { tp: 2, fp: 1, fn: 1 });
    assert.deepEqual(classCounts(m, 'b'), { tp: 1, fp: 1, fn: 1 });
  });

  it('computes accuracy and macro-F1', () => {
    close(accuracy(m), 4 / 7);
    const expected = (prf({ tp: 2, fp: 1, fn: 1 }).f1 + prf({ tp: 1, fp: 1, fn: 1 }).f1 + prf({ tp: 1, fp: 1, fn: 1 }).f1) / 3;
    close(macroF1(m, labels), expected);
  });

  it('collapses to a binary question, counting a positive predicted as another positive class as found', () => {
    assert.deepEqual(
      binaryCounts(m, (l) => l !== 'none'),
      { tp: 4, fp: 1, fn: 1 },
    );
  });

  it('rejects labels outside the label set', () => {
    assert.throws(() => confusion(['a', 'b'] as const, [['a', 'c' as 'a']]), /label outside/);
  });

  it('treats an empty matrix as fully accurate', () => {
    assert.equal(accuracy(confusion(['a'] as const, [])), 1);
  });
});

describe('scoreField', () => {
  it('does not score a field the case does not label', () => {
    assert.equal(scoreField(undefined, 5), 'unscored');
  });

  it('requires absence when the label is null', () => {
    assert.equal(scoreField(null, undefined), 'correct');
    assert.equal(scoreField<number>(null, 499), 'wrong');
  });

  it('requires equality, and counts a missing prediction as wrong', () => {
    assert.equal(scoreField(1199, 1199), 'correct');
    assert.equal(scoreField(1199, 999), 'wrong');
    assert.equal(scoreField(1199, undefined), 'wrong');
  });

  it('accepts a custom comparison', () => {
    const sameWord = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    assert.equal(scoreField('Netflix', 'NETFLIX', sameWord), 'correct');
  });
});

describe('tally and rate', () => {
  it('counts scored outcomes and ignores unscored ones', () => {
    let t = zeroTally();
    for (const o of ['correct', 'wrong', 'unscored', 'correct'] as const) t = tally(t, o);
    assert.deepEqual(t, { correct: 2, total: 3 });
    close(rate(t) ?? NaN, 2 / 3);
  });

  it('has no rate when nothing was scored, so it is never gated', () => {
    assert.equal(rate(zeroTally()), undefined);
  });
});

describe('matchByOverlap', () => {
  it('pairs each prediction with the gold entity it shares the most ids with', () => {
    const r = matchByOverlap(
      [
        ['t1', 't2', 't3'],
        ['t7', 't8'],
      ],
      [['t7', 't8', 't9'], ['t1', 't2', 't3', 't4']],
    );
    assert.deepEqual(r.matches, [
      { pred: 1, gold: 0, overlap: 2 },
      { pred: 0, gold: 1, overlap: 3 },
    ]);
    assert.deepEqual(r.unmatchedPreds, []);
    assert.deepEqual(r.unmatchedGolds, []);
  });

  it('leaves a second prediction for the same gold entity unmatched (a split counts as a false positive)', () => {
    const r = matchByOverlap([['a1', 'a2'], ['a3']], [['a1', 'a2', 'a3']]);
    assert.deepEqual(r.matches, [{ pred: 0, gold: 0, overlap: 2 }]);
    assert.deepEqual(r.unmatchedPreds, [1]);
  });

  it('never pairs entities that share no id', () => {
    const r = matchByOverlap([['x1']], [['y1']]);
    assert.deepEqual(r.matches, []);
    assert.deepEqual(r.unmatchedPreds, [0]);
    assert.deepEqual(r.unmatchedGolds, [0]);
  });

  it('breaks ties by index so results are deterministic', () => {
    const r = matchByOverlap([['s1'], ['s1']], [['s1']]);
    assert.deepEqual(r.matches, [{ pred: 0, gold: 0, overlap: 1 }]);
    assert.deepEqual(r.unmatchedPreds, [1]);
  });

  it('counts duplicate ids in a prediction once', () => {
    const r = matchByOverlap([['d1', 'd1', 'd1']], [['d1', 'd2']]);
    assert.equal(r.matches[0]?.overlap, 1);
  });
});

describe('compareToBaseline', () => {
  const baseline: Baseline = { tolerance: 0.01, datasets: { emails: 'abc' }, metrics: { 'a.f1': 0.8, 'b.recall': 0.5, 'c.acc': 0.9 } };

  it('passes when nothing dropped by more than the tolerance', () => {
    const g = compareToBaseline({ datasets: { emails: 'abc' }, metrics: { 'a.f1': 0.795, 'b.recall': 0.5, 'c.acc': 0.9 } }, baseline);
    assert.equal(g.ok, true);
    assert.deepEqual(g.regressions, []);
  });

  it('allows a drop of exactly the tolerance', () => {
    const g = compareToBaseline({ datasets: { emails: 'abc' }, metrics: { 'a.f1': 0.79, 'b.recall': 0.5, 'c.acc': 0.9 } }, baseline);
    assert.equal(g.ok, true);
  });

  it('fails on a drop larger than the tolerance and reports the delta', () => {
    const g = compareToBaseline({ datasets: { emails: 'abc' }, metrics: { 'a.f1': 0.7, 'b.recall': 0.5, 'c.acc': 0.9 } }, baseline);
    assert.equal(g.ok, false);
    assert.deepEqual(g.regressions, [{ key: 'a.f1', baseline: 0.8, current: 0.7, delta: -0.1 }]);
  });

  it('lists improvements without failing', () => {
    const g = compareToBaseline({ datasets: { emails: 'abc' }, metrics: { 'a.f1': 0.8, 'b.recall': 0.75, 'c.acc': 0.9 } }, baseline);
    assert.equal(g.ok, true);
    assert.deepEqual(g.improvements.map((d) => d.key), ['b.recall']);
  });

  it('fails when a baseline metric is missing from the run', () => {
    const g = compareToBaseline({ datasets: { emails: 'abc' }, metrics: { 'a.f1': 0.8, 'b.recall': 0.5 } }, baseline);
    assert.equal(g.ok, false);
    assert.deepEqual(g.missing, ['c.acc']);
  });

  it('fails when a dataset changed since the baseline was recorded', () => {
    const g = compareToBaseline({ datasets: { emails: 'def' }, metrics: baseline.metrics }, baseline);
    assert.equal(g.ok, false);
    assert.deepEqual(g.changedDatasets, ['emails']);
  });

  it('accepts a tolerance override and ignores float noise below 4 decimals', () => {
    const strict = compareToBaseline({ datasets: { emails: 'abc' }, metrics: { 'a.f1': 0.79999999, 'b.recall': 0.5, 'c.acc': 0.9 } }, baseline, 0);
    assert.equal(strict.ok, true);
    const loose = compareToBaseline({ datasets: { emails: 'abc' }, metrics: { 'a.f1': 0.7, 'b.recall': 0.5, 'c.acc': 0.9 } }, baseline, 0.2);
    assert.equal(loose.ok, true);
  });

  it('rounds to 4 decimals', () => {
    assert.equal(round(0.123456), 0.1235);
    assert.equal(round(2 / 3, 2), 0.67);
  });
});
