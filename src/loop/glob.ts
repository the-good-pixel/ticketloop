// Tiny glob matcher supporting ** and * — enough for exclude patterns.
function toRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++ // consume trailing slash of **/
      } else {
        re += '[^/]*'
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

export function matchesAny(path: string, patterns: string[]): string | null {
  const norm = path.replace(/^\.?\//, '')
  for (const p of patterns) {
    if (toRegExp(p).test(norm)) return p
  }
  return null
}
