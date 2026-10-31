/**
 * 版本单点。package.json 里的 version 必须与它一致，由 test-packaging.mjs 断言。
 * 打包工具不能读 ESM 常量时会回退读 package.json，所以两处都要在。
 */
export const VERSION = '0.21.0-beta.1'
