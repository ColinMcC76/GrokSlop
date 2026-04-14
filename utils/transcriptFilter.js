/**
 * Skip empty / noise-only STT so Discord does not get blank or junk lines.
 */
function isSubstantiveTranscript(text) {
    const t = (text || '').replace(/\u00a0/g, ' ').trim();
    if (!t) return false;
    if (t.length === 1 && !/[\p{L}\p{N}]/u.test(t)) return false;
    const lettersOrDigits = t.replace(/[^\p{L}\p{N}]/gu, '');
    if (lettersOrDigits.length === 0) return false;
    if (/^([.!?…,;:~\-]|\.{2,}|\s)+$/u.test(t)) return false;
    if (/^(um+|uh+|ah+|er+|hm+|hmm+|mhm+)[.!?…,]*$/iu.test(t)) return false;
    return true;
}

module.exports = { isSubstantiveTranscript };
