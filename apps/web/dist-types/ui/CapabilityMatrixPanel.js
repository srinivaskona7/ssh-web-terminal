import { jsx as _jsx, jsxs as _jsxs } from "preact/jsx-runtime";
import { useMemo, useState } from 'preact/hooks';
import { Badge, Button } from '@webssh/ui-kit';
import { CAPABILITY_MATRIX, capabilityCounts } from './capability-matrix.js';
const STATUS_LABEL = {
    verified: 'Tested in this repo',
    implemented: 'Implemented · real-server test pending',
    conditional: 'Needs a prerequisite',
    unsupported: 'Deliberately unsupported'
};
const STATUS_TONE = {
    verified: 'success',
    implemented: 'neutral',
    conditional: 'warning',
    unsupported: 'danger'
};
const CATEGORIES = [
    'All',
    'Connection & identity',
    'Terminal',
    'Files & editor',
    'Discovery & install',
    'Operations',
    'Automation & delivery'
];
/**
 * Replaces the old marketing "50 features" workbench. Every row is a code path
 * that exists in this repository, with the proof level stated plainly.
 */
export function CapabilityMatrixPanel() {
    const [category, setCategory] = useState('All');
    const [query, setQuery] = useState('');
    const counts = useMemo(() => capabilityCounts(), []);
    const entries = useMemo(() => CAPABILITY_MATRIX.filter((entry) => {
        if (category !== 'All' && entry.category !== category)
            return false;
        const q = query.trim().toLowerCase();
        if (!q)
            return true;
        return (entry.name.toLowerCase().includes(q) ||
            entry.detail.toLowerCase().includes(q) ||
            entry.category.toLowerCase().includes(q));
    }), [category, query]);
    return (_jsxs("div", { className: "webssh-panel-content", "data-testid": "screen-features", children: [_jsx("div", { className: "ws-mod-head", children: _jsxs("div", { children: [_jsx("h1", { children: "Capability matrix" }), _jsx("p", { className: "ws-mod-muted", children: "What works, what is tested, and what needs something from you. Rows marked \u201Creal-server test pending\u201D have code but have not been exercised against a live disposable host in this build." })] }) }), _jsx("div", { className: "ws-mod-chips", children: ['verified', 'implemented', 'conditional', 'unsupported'].map((status) => (_jsxs(Badge, { tone: STATUS_TONE[status], children: [STATUS_LABEL[status], ": ", counts[status]] }, status))) }), _jsxs("div", { className: "ws-mod-filters", children: [CATEGORIES.map((cat) => (_jsx(Button, { variant: category === cat ? 'primary' : 'ghost', onClick: () => setCategory(cat), testId: `capability-cat-${cat.toLowerCase().replace(/[^a-z]+/g, '-')}`, children: cat }, cat))), _jsx("input", { type: "search", className: "ui-input", placeholder: "Search capabilities\u2026", "aria-label": "Search capabilities", value: query, onInput: (e) => setQuery(e.target.value), style: { flex: 1, minWidth: '200px' } })] }), _jsxs("table", { className: "ws-mod-table", "data-testid": "capability-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Capability" }), _jsx("th", { children: "Category" }), _jsx("th", { children: "Status" }), _jsx("th", { children: "Detail" })] }) }), _jsxs("tbody", { children: [entries.map((entry) => (_jsxs("tr", { "data-testid": `capability-${entry.id}`, children: [_jsx("td", { children: entry.name }), _jsx("td", { children: entry.category }), _jsx("td", { children: _jsx(Badge, { tone: STATUS_TONE[entry.status], children: STATUS_LABEL[entry.status] }) }), _jsxs("td", { children: [entry.detail, entry.requires ? _jsxs("div", { className: "ws-mod-muted", children: ["Requires: ", entry.requires] }) : null] })] }, entry.id))), entries.length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 4, className: "ws-mod-muted", children: "No capability matches that filter." }) })) : null] })] })] }));
}
//# sourceMappingURL=CapabilityMatrixPanel.js.map