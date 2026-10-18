/**
 * The pre-transform stroke a fitted group carries.
 *
 * The fit transform multiplies the stroke by its own scale, so dividing the
 * requested weight by that scale lands the drawn stroke exactly on it.
 */
export function cioStrokeWidth(requested, fitScale) {
    return requested / fitScale;
}
