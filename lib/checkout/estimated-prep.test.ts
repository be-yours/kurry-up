import { describe, expect, it } from 'vitest'
import { estimatedPrepMinutes } from './estimated-prep'

const dish = (id: string, preparationTime?: number | null) => ({ _id: id, preparationTime })

describe('estimatedPrepMinutes', () => {
  it('is the longest dish, because they are cooked side by side', () => {
    const lines = [{ productId: 'a' }, { productId: 'b' }, { productId: 'a' }]
    expect(estimatedPrepMinutes(lines, [dish('a', 12), dish('b', 20)])).toBe(20)
  })

  it("is the dish's own time for a basket of one", () => {
    expect(estimatedPrepMinutes([{ productId: 'a' }], [dish('a', 12)])).toBe(12)
  })

  it('says nothing for an empty basket', () => {
    expect(estimatedPrepMinutes([], [dish('a', 12)])).toBeUndefined()
  })

  it('says nothing when a dish nobody timed is in the basket', () => {
    // Understating is worse than silence: the diner would plan around it.
    const lines = [{ productId: 'a' }, { productId: 'b' }]
    expect(estimatedPrepMinutes(lines, [dish('a', 12), dish('b')])).toBeUndefined()
    expect(estimatedPrepMinutes(lines, [dish('a', 12), dish('b', null)])).toBeUndefined()
    expect(estimatedPrepMinutes(lines, [dish('a', 12), dish('b', 0)])).toBeUndefined()
  })

  it('says nothing when a dish is no longer on sale and so was not returned', () => {
    expect(estimatedPrepMinutes([{ productId: 'gone' }], [dish('a', 12)])).toBeUndefined()
  })

  it('says nothing for a formule, whose time is on the menu row the server reads', () => {
    const lines = [{ productId: 'a' }, { menu: { menuId: 'm1' } }]
    expect(estimatedPrepMinutes(lines, [dish('a', 12)])).toBeUndefined()
  })

  it('says nothing for a line that names no product', () => {
    expect(estimatedPrepMinutes([{}], [dish('a', 12)])).toBeUndefined()
  })

  it('rounds a fractional time to whole minutes', () => {
    expect(estimatedPrepMinutes([{ productId: 'a' }], [dish('a', 12.4)])).toBe(12)
  })
})
