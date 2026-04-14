const PATTERNS = [
    'latest',
    'recent',
    'today',
    'right now',
    'currently',
    'this week',
    'breaking',
    'news',
    'update',
    'what happened',
    'what is happening',
    'hormuz',
    'iran',
    'israel',
    'gaza',
    'ukraine',
    'election',
    'president',
    'prime minister',
    'ceo',
    'stock',
    'price',
    'weather',
    'score',
    'war',
    'conflict'
];

const WEB_SEARCH_PATTERN = new RegExp(
    PATTERNS.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'i'
);

function needsWebSearch(text) {
    return Boolean(text && WEB_SEARCH_PATTERN.test(text));
}

module.exports = {
    needsWebSearch
};
