// Nim rules (misère: whoever takes the last match loses) and the opponent's mind.

export const nimSum = (rows) => rows.reduce((a, b) => a ^ b, 0);

// Is `rows` a losing position for the player about to move? (misère play)
export function isLosing(rows) {
  const big = rows.some((r) => r > 1);
  if (!big) {
    const ones = rows.filter((r) => r === 1).length;
    return ones % 2 === 1;
  }
  return nimSum(rows) === 0;
}

export function legalMoves(rows) {
  const moves = [];
  rows.forEach((n, r) => {
    for (let k = 1; k <= n; k++) moves.push({ row: r, take: k });
  });
  return moves;
}

export function apply(rows, m) {
  const out = rows.slice();
  out[m.row] -= m.take;
  return out;
}

/**
 * The opponent plays perfectly, except that early in a game it sometimes
 * makes a quiet, plausible mistake (so the player who studies it can win).
 */
export function chooseMove(rows, rnd, { errorRate = 0.12 } = {}) {
  const total = rows.reduce((a, b) => a + b, 0);
  const moves = legalMoves(rows);
  const winning = moves.filter((m) => isLosing(apply(rows, m)));
  const err = total > 7 ? errorRate : 0;
  if (winning.length && rnd() >= err) {
    // among winning moves, prefer the one that looks most natural (small takes, bigger rows)
    winning.sort((a, b) => a.take - b.take || rows[b.row] - rows[a.row]);
    return winning[Math.floor(rnd() * Math.min(2, winning.length))];
  }
  // losing (or erring): stall — take one from the largest row, avoiding the very last match if possible
  const nonLast = moves.filter((m) => apply(rows, m).some((r) => r > 0));
  const pool = nonLast.length ? nonLast : moves;
  const singles = pool.filter((m) => m.take === 1);
  const from = singles.length ? singles : pool;
  from.sort((a, b) => rows[b.row] - rows[a.row]);
  return from[Math.floor(rnd() * Math.min(2, from.length))];
}
