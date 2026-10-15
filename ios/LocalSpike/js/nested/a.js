// Check 3: a nested static import, root-relative and ../../ relative.
import { b } from '/static/b.js';
import { c } from '../../domain/c.js';

export const nested = { a: 'a', b, c, url: import.meta.url };
