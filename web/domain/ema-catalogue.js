// Standalone Article 57 exact-name index. Data is injected by the caller;
// there is no adapter, medication integration, identity mapping or I/O here.
const COLUMNS = ['name', 'substances', 'route', 'jurisdiction'];
const SOURCE_KEYS = ['url', 'page_url', 'revision', 'data_date', 'published_date',
    'sha256', 'reuse_url', 'reuse_checked', 'attribution'];

function validText(value) {
    return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

// Unicode lowercase + outer trim only: no accent, punctuation, word-order,
// salt, spelling or pharmaceutical-product transformation.
function key(value) { return value.trim().toLowerCase(); }

export function createEMACatalogue(data) {
    if (!data || data.schema_version !== 1 ||
        JSON.stringify(data.columns) !== JSON.stringify(COLUMNS) ||
        !Array.isArray(data.rows) || data.rows.length === 0 ||
        !Number.isInteger(data.source_rows) || data.source_rows < data.rows.length ||
        !data.source || Object.keys(data.source).length !== SOURCE_KEYS.length ||
        !SOURCE_KEYS.every(field => validText(data.source[field])) ||
        !/^[a-f0-9]{64}$/.test(data.source.sha256)) {
        throw new TypeError('Invalid EMA catalogue schema/provenance');
    }
    const source = Object.freeze({ ...data.source });
    const index = new Map();
    const seen = new Set();
    for (const row of data.rows) {
        if (!Array.isArray(row) || row.length !== 4 || !row.every(validText)) {
            throw new TypeError('Invalid EMA catalogue row');
        }
        // Defensive exact duplicate suppression never collapses case variants,
        // different countries, routes or substance text.
        const serialized = JSON.stringify(row);
        if (seen.has(serialized)) continue;
        seen.add(serialized);
        const candidate = Object.freeze(Object.fromEntries(COLUMNS.map((field, i) => [field, row[i]])));
        const name = key(row[0]);
        if (!index.has(name)) index.set(name, []);
        index.get(name).push(candidate);
    }

    return Object.freeze({
        source,
        // Jurisdiction means an EXACT source label. EU-wide inclusion is an
        // explicit caller option; a national filter does not silently imply it.
        exact(name, options = {}) {
            let candidates = [];
            const validOptions = options && typeof options === 'object' && !Array.isArray(options) &&
                Object.keys(options).every(field => ['jurisdiction', 'includeEUWide'].includes(field)) &&
                (options.jurisdiction === undefined || validText(options.jurisdiction)) &&
                (options.includeEUWide === undefined || typeof options.includeEUWide === 'boolean');
            if (validText(name) && validOptions) {
                candidates = (index.get(key(name)) || []).filter(candidate =>
                    options.jurisdiction === undefined || candidate.jurisdiction === options.jurisdiction ||
                    (options.includeEUWide === true && candidate.jurisdiction === 'European Union'));
            }
            return Object.freeze({ source, candidates: Object.freeze(candidates), ambiguous: candidates.length > 1 });
        },
    });
}
