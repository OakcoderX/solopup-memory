/** Child environment is allowlisted; never inherit credentials, proxies or hooks. */
import { join } from 'node:path'
export function probeEnvironment(root, parent = process.env) {
  const home = join(root, 'home')
  return { PATH: parent.PATH ?? '', HOME: home, USERPROFILE: home, DSH_HOME: home,
    TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' }
}
