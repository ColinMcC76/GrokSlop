function needsWebSearch(text) {
    if (!text) return false;

    const lower = text.toLowerCase();

    const patterns = [
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

    return patterns.some(pattern => lower.includes(pattern));
}

module.exports = {
    needsWebSearch
};