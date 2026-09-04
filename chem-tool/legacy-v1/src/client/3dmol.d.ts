// 3Dmol ships an ES module build without a matching "module" entry in its
// package.json; import it by path and reuse the package's own types.
declare module '3dmol/build/3Dmol.es6.js' {
  export * from '3dmol';
}
