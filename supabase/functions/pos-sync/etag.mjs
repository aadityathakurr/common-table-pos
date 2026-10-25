/** @param {string | null} header @param {string} expectedEtag @returns {boolean} */
export function ifNoneMatchMatches(header, expectedEtag) {
  if (!header) return false;
  return header.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || tag.replace(/^W\//, '') === expectedEtag;
  });
}
