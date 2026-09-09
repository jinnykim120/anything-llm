UPDATE document_classifications
SET workType = '기타'
WHERE workType IS NOT NULL
  AND workType NOT IN ('동반성장', '공정거래', '기타');
