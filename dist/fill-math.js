/* A trade is one position cycle. Fills are ordered executions, not separate trades. */
const TradeFillMath = (() => {
  const EPSILON = 1e-8;
  const roundMoney = value => Math.round((value + Number.EPSILON) * 100) / 100;

  function summarize(trade, inputFills = trade.fills || []) {
    const openingSide = trade.direction === 'SHORT' ? 'sell' : 'buy';
    const closingSide = openingSide === 'buy' ? 'sell' : 'buy';
    const fills = inputFills.map((fill, index) => ({ ...fill, index })).sort((a, b) =>
      Date.parse(a.executedAt) - Date.parse(b.executedAt) || a.index - b.index
    );
    let openQuantity = 0;
    let entryCost = 0;
    let realizedPl = 0;
    let openingCount = 0;
    let closingCount = 0;
    let completed = false;
    let multiplier = null;
    const steps = [];

    for (const fill of fills) {
      const quantity = Number(fill.quantity);
      const unitPrice = Number(fill.unitPrice);
      const factor = Number(fill.multiplier ?? 1);
      const commission = Number(fill.commission ?? 0);
      const otherFees = Number(fill.otherFees ?? 0);
      const fees = commission + otherFees;
      if (!['buy', 'sell'].includes(fill.action) || !Number.isFinite(quantity) || quantity <= 0 ||
          !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(factor) || factor <= 0 ||
          !Number.isFinite(commission) || commission < 0 || !Number.isFinite(otherFees) || otherFees < 0 ||
          Number.isNaN(Date.parse(fill.executedAt))) {
        throw new Error('ข้อมูลไม้ซื้อขายไม่ถูกต้อง กรุณาตรวจจำนวน ราคา ค่าธรรมเนียม และวันที่');
      }
      if (multiplier !== null && factor !== multiplier) throw new Error('ไม้ในรายการเดียวกันต้องใช้ตัวคูณเดียวกัน');
      multiplier = factor;
      if (completed) throw new Error('ปิดครบแล้ว หากเข้าใหม่ให้สร้างรายการเทรดใหม่');
      const gross = quantity * unitPrice * factor;
      let label;
      let realizedOnFill = 0;
      if (fill.action === openingSide) {
        openingCount++;
        label = trade.direction === 'SHORT' ? `ขายเปิดไม้ ${openingCount}` : `ซื้อไม้ ${openingCount}`;
        openQuantity += quantity;
        entryCost += gross + (openingSide === 'buy' ? fees : -fees);
      } else if (fill.action === closingSide) {
        if (quantity - openQuantity > EPSILON) throw new Error('จำนวนที่ขาย/ซื้อคืนมากกว่าจำนวนที่ถืออยู่');
        closingCount++;
        const unitCost = entryCost / openQuantity;
        const allocatedCost = unitCost * quantity;
        realizedOnFill = (openingSide === 'buy' ? gross - fees - allocatedCost : allocatedCost - gross - fees);
        realizedPl += realizedOnFill;
        entryCost -= allocatedCost;
        openQuantity -= quantity;
        if (openQuantity < EPSILON) {
          openQuantity = 0;
          entryCost = 0;
          completed = true;
        }
        label = trade.direction === 'SHORT'
          ? (completed ? 'ซื้อคืนปิดครบ' : `ซื้อคืนบางส่วน ${closingCount}`)
          : (completed ? 'ขายปิดครบ' : `ขายบางส่วน ${closingCount}`);
      }
      steps.push({ ...fill, label, gross, fees, realizedOnFill: roundMoney(realizedOnFill), remainingQuantity: openQuantity });
    }
    return {
      steps,
      openQuantity,
      averageEntry: openQuantity ? entryCost / openQuantity / (multiplier || 1) : null,
      realizedPl: roundMoney(realizedPl),
      status: completed ? 'closed' : 'pending',
      pl: completed ? roundMoney(realizedPl) : null
    };
  }
  return { summarize };
})();
if (typeof module !== 'undefined') module.exports = TradeFillMath;
