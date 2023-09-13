export let startsWith: (str: string, strToFind: string) => boolean;

const hasStartsWith = (String.prototype as any).startsWith;
if (hasStartsWith) {
  startsWith = function (str: string & { startsWith(strToFind: string): boolean }, strToFind: string): boolean {
    return str.startsWith(strToFind);
  }
}
else {
  startsWith = function (str: string, strToFind: string): boolean {
    return str.lastIndexOf(strToFind, 0) === 0;
  }
}

export const array_equal = (a: Array<string>, b: Array<string>) => {
  if (!Array.isArray(a)) return false;
  if (!Array.isArray(b)) return false;
  if (a.length != b.length) return false;
  for (var i = 0, n = a.length; i < n; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}