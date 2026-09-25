export const RESERVED_SEATS_BY_TRIP = `
  SELECT h."organizationId", h."tripId", SUM(h."seatCount")::int AS seats
  FROM "hold" h
  LEFT JOIN "booking" b ON b."holdId" = h.id AND b."organizationId" = h."organizationId"
  WHERE b.status = 'CONFIRMED'
     OR (h.status = 'ACTIVE' AND h."expiresAt" > $1)
     OR EXISTS (
       SELECT 1 FROM "payment" p
       WHERE p."organizationId" = h."organizationId" AND p."holdId" = h.id AND p.status = 'PENDING'
     )
  GROUP BY h."organizationId", h."tripId"
`
