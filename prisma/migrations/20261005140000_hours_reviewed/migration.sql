-- Passo "Confira os horários" dos primeiros passos do painel.
ALTER TABLE "company_settings" ADD COLUMN "hoursReviewedAt" TIMESTAMP(3);

-- Empresas que já mudaram algum horário do padrão contam como revisadas.
UPDATE "company_settings"
SET "hoursReviewedAt" = CURRENT_TIMESTAMP
WHERE "openingTime" <> '09:00'
   OR "closingTime" <> '18:00'
   OR "workDays" <> ARRAY[1, 2, 3, 4, 5, 6]
   OR "slotMinutes" <> 30
   OR "slotCapacity" <> 1
   OR "lunchEnabled" = true;
