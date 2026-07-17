import { higherIsWorseBand } from './shared.js';

// "Higher is worse": currentValue is the percent spike in burn rate versus
// the trailing average, see Design Notes in the story spec.
export const getBand = higherIsWorseBand;
