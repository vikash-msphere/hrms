-- One board's live cards, newest first, for the Boards page's `GET /v1/cards?board=` walk: each keyset page is one
-- seek and a page of index steps instead of the board's whole range read and sorted again for every page.
-- db/schema.ts carries the measurement beside the index. Index-only: no stored row changes.
CREATE INDEX `card_board_created_idx` ON `cards` (`board_id`,`created_at`,`uuid`) WHERE "cards"."delete_time" is null;
