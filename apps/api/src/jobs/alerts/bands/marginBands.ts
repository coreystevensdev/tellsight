import { higherIsWorseBand } from './shared.js';

// margin_drops threshold is the drop magnitude (percentage points a margin
// has fallen by), so this is a "higher is worse" metric like the burn and
// break-even kinds, not a "lower is worse" one despite the name.
export const getBand = higherIsWorseBand;
