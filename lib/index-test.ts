import { assert } from 'chai'
import { foo } from './index'

describe('foo', () => {
  it('loads', () => {
    assert.equal(foo, 'bar')
  })
})
