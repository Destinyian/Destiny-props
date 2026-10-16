// 行为测试：堆积剖面的不变式（planSettledColumns 是纯函数，不需要画布）。
//
//   node --test tests/
//
// 两条核心不变式都直接对应卡片里的承诺：
//   1. 质量守恒 —— 每一颗字符都拿得到预分配落点，不会退化成动态落地；
//   2. 剖面是流动规则的不动点 —— 所以落定之后不会再有粒子互相搬动（不晃动）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { planSettledColumns, GLYPH_GRAVITY_DEFAULTS } from '../src/glyphGravity.js';

const PACKING = 5.39; // 默认密度下两行字符的垂直间距（引擎内 PACKING × glyphSize）

const hist = (cols, per) => ({ masses: new Int32Array(cols).fill(per), total: cols * per });
const needOf = (repose) => Math.max(2, Math.round(repose / PACKING));
const maxStep = (counts) => {
  let m = 0;
  for (let i = 0; i < counts.length - 1; i++) m = Math.max(m, Math.abs(counts[i] - counts[i + 1]));
  return m;
};
const sum = (counts) => counts.reduce((a, b) => a + b, 0);

test('质量守恒：每一颗字符都会拿到落点（总数与列数无关）', () => {
  for (const cols of [60, 186, 320]) {
    const { masses, total } = hist(cols, Math.round(5000 / cols));
    for (const peaks of [0, 2, 3, 4]) {
      const counts = planSettledColumns({ cols, masses, total, repose: 24, packing: PACKING, peaks });
      assert.equal(sum(counts), total, `cols=${cols} peaks=${peaks}`);
    }
  }
});

test('落定即静止：剖面是流动规则的不动点（相邻列高差小于阈值）', () => {
  for (const repose of [18, 24, 32, 56]) {
    const need = needOf(repose);
    for (const peaks of [0, 2, 3, 4, 6]) {
      const { masses, total } = hist(186, 27);
      const counts = planSettledColumns({ cols: 186, masses, total, repose, packing: PACKING, peaks });
      assert.ok(maxStep(counts) < need, `repose=${repose} peaks=${peaks}：最大相邻差 ${maxStep(counts)} 应 < ${need}`);
    }
  }
});

test('山峰数量可控：peaks=0 是一条等高平脊，山越多则主峰越低', () => {
  const { masses, total } = hist(186, 27);
  const base = { cols: 186, masses, total, repose: 24, packing: PACKING };
  assert.equal(maxStep(planSettledColumns({ ...base, peaks: 0 })), 0, 'peaks=0 应弛豫为等高平脊');
  const two = Math.max(...planSettledColumns({ ...base, peaks: 2 }));
  const four = Math.max(...planSettledColumns({ ...base, peaks: 4 }));
  assert.ok(two > four, `2 座山（${two}）应比 4 座山（${four}）高`);
});

test('山体之间留有平坦底盘，不是整片都在坡上', () => {
  const { masses, total } = hist(186, 27);
  const counts = planSettledColumns({ cols: 186, masses, total, repose: 24, packing: PACKING, peaks: 3 });
  const bed = Math.min(...counts);
  const flat = counts.filter((c) => c <= bed + 1).length;
  assert.ok(flat >= counts.length * 0.15, `底盘应占至少 15% 的列，实际 ${flat}/${counts.length}`);
});

test('repose 是坡度上限：阈值越大山越高', () => {
  const { masses, total } = hist(186, 27);
  const base = { cols: 186, masses, total, packing: PACKING, peaks: 3 };
  const low = Math.max(...planSettledColumns({ ...base, repose: 18 }));
  const high = Math.max(...planSettledColumns({ ...base, repose: 56 }));
  assert.ok(high > low, `repose 56（${high}）应比 18（${low}）高`);
});

test('默认值守住已确认的产品行为', () => {
  assert.match(GLYPH_GRAVITY_DEFAULTS.characters, /^[A-Za-z]+$/, '字符池默认只有英文字母');
  assert.equal(GLYPH_GRAVITY_DEFAULTS.shuffle, 0, '字形成形后不再随机跳变');
  assert.equal(GLYPH_GRAVITY_DEFAULTS.staticSettle, true, '坍塌走预计算堆积');
  assert.equal(GLYPH_GRAVITY_DEFAULTS.eraseMode, 'hover', '划过即削，无需按键');
  assert.ok(GLYPH_GRAVITY_DEFAULTS.autoRestoreMs > 0, '默认开启闲置自动恢复');
});
