import resolve from 'rollup-plugin-node-resolve'
import commonjs from 'rollup-plugin-commonjs'
import json from 'rollup-plugin-json'

export default [{
  input: './dist-ts/download.js',
  plugins: [
    json({
      preferConst: true,
      compact: true,
      namedExports: false
    }),
    resolve({}),
    commonjs({
      namedExports: { 'mkdirp': [ 'mkdirp' ] }
    }),
  ],
  output: {
    format: 'commonjs',
    file: './bin/download.js'
  }
},{
  input: './dist-ts/index.js',
  plugins: [
    json({
      preferConst: true,
      compact: true,
      namedExports: false
    }),
    resolve({})
  ],
  output: [
    { format: 'esm', file: './dist/index-esm.js' },
    { format: 'umd', name: 'streamingIterables', file: './dist/index.js' }
  ]
}]
