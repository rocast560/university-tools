// Dense linear solve for the MNA system. Circuits on a breadboard give
// matrices well under 100x100, so dense Gaussian elimination with partial
// pivoting is the right tool; sparsity would be over-engineering.

/**
 * Solve A x = b by Gaussian elimination with partial pivoting.
 * A and b are consumed (modified in place). Returns null when A is singular.
 */
export function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    // Partial pivoting: the largest magnitude in the column becomes the pivot,
    // which both rescues a zero pivot and keeps the error growth bounded.
    let best = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(A[row][col]) > Math.abs(A[best][col])) best = row;
    if (best !== col) {
      [A[col], A[best]] = [A[best], A[col]];
      [b[col], b[best]] = [b[best], b[col]];
    }
    const piv = A[col][col];
    if (piv === 0) return null;
    for (let row = col + 1; row < n; row++) {
      const f = A[row][col] / piv;
      if (f === 0) continue;
      for (let k = col; k < n; k++) A[row][k] -= f * A[col][k];
      b[row] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let s = b[row];
    for (let k = row + 1; k < n; k++) s -= A[row][k] * x[k];
    x[row] = s / A[row][row];
  }
  return x;
}

/** An n x n matrix of zeros. */
export function zeros(n: number): number[][] {
  return Array.from({ length: n }, () => new Array<number>(n).fill(0));
}
