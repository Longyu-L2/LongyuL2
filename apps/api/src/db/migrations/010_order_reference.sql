-- An order's on-chain ID is now derived by the router from a random reference, the token and the
-- amount (PaymentRouter.orderIdOf), so a payment of any other amount cannot use the order up.
-- order_id stays the ID in the OrderPaid event; pay_ref is what the payer sends.
ALTER TABLE orders ADD COLUMN pay_ref TEXT CHECK (pay_ref ~ '^0x[0-9a-f]{64}$');

-- Orders opened for the earlier router cannot be paid through this one.
UPDATE orders SET status = 'cancelled', resolution_note = 'replaced by the payment reference scheme'
 WHERE status = 'open' AND pay_ref IS NULL;
