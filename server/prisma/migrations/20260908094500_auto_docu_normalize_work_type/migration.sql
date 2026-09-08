-- The archive work classification is intentionally a closed three-value axis.
-- Existing proposals are normalized from their subject domain so old values do
-- not create orphan folders in the document room.
UPDATE "document_classifications"
SET "workType" = CASE
  WHEN "domain" = '동반성장' THEN '동반성장'
  WHEN "domain" = '공정거래' THEN '공정거래'
  ELSE '기타'
END
WHERE "workType" IS NOT NULL;
