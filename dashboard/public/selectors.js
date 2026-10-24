const SELECTION_KEY = 'grokslop-selection';

function readSelection() {
    try {
        const parsed = JSON.parse(localStorage.getItem(SELECTION_KEY) || '{}');
        if (!parsed || typeof parsed !== 'object') {
            return {};
        }
        return parsed;
    } catch {
        return {};
    }
}

function writeSelection(patch) {
    try {
        localStorage.setItem(SELECTION_KEY, JSON.stringify({ ...readSelection(), ...patch }));
    } catch {
        /* private mode */
    }
}

function fillSelect(select, items, placeholder, labelFor, saved) {
    const current = select.value || saved || '';
    select.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = placeholder;
    select.appendChild(blank);
    for (const item of items) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = labelFor(item);
        select.appendChild(option);
    }
    if (current && [...select.options].some((option) => option.value === current)) {
        select.value = current;
    }
}
