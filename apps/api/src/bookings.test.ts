import { describe, expect, it } from 'bun:test'
import { invoiceAmount } from './bookings'

describe('Booking invoices', () => {
  it('calculates the invoice from fixed Trip price times held seats', () => {
    expect(invoiceAmount(150000, 3)).toBe(450000)
  })

  it('rejects invalid invoice inputs', () => {
    expect(() => invoiceAmount(-1, 1)).toThrow('price and seatCount must be valid integers')
    expect(() => invoiceAmount(1000, 0)).toThrow('price and seatCount must be valid integers')
  })
})
