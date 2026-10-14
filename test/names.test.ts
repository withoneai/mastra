import { describe, expect, it } from 'vitest'
import { approvalNeeded, isWriteAction } from '../src/names.js'

describe('isWriteAction / approvalNeeded', () => {
  it('reads GET, writes PUT/PATCH/DELETE, and decides POST by its title', () => {
    expect(isWriteAction({ method: 'GET', title: 'Delete-looking title' })).toBe(false)
    expect(isWriteAction({ method: 'DELETE', title: 'List' })).toBe(true)
    expect(isWriteAction({ method: 'POST', title: 'List Issues' })).toBe(false)
    expect(isWriteAction({ method: 'POST', title: 'Create Issue' })).toBe(true)
    expect(isWriteAction({ method: 'POST', title: 'Frobnicate' })).toBe(true)
  })

  it("applies true, 'writes' and globs", () => {
    const list = { method: 'POST', title: 'List Issues' }
    const create = { method: 'POST', title: 'Create Issue' }
    expect(approvalNeeded(true, 'linear_list_issues', list)).toBe(true)
    expect(approvalNeeded('writes', 'linear_list_issues', list)).toBe(false)
    expect(approvalNeeded('writes', 'linear_create_issue', create)).toBe(true)
    expect(approvalNeeded(['*_create_*'], 'linear_create_issue', create)).toBe(true)
    expect(approvalNeeded(undefined, 'linear_create_issue', create)).toBe(false)
  })
})
