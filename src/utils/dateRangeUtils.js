const getDateRangeFilter = (range, start, end) => {
  const now = new Date();
  let gte, lt;

  switch (range) {
    case 'Day':
      gte = new Date();
      gte.setHours(0, 0, 0, 0);
      lt = new Date(gte);
      lt.setDate(lt.getDate() + 1);
      break;
    case 'Week':
      gte = new Date();
      gte.setDate(now.getDate() - 7);
      gte.setHours(0, 0, 0, 0);
      lt = new Date(now);
      break;
    case 'Month':
      gte = new Date(now.getFullYear(), now.getMonth(), 1);
      lt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      break;
    case 'Quarter': {
      const currentQuarter = Math.floor(now.getMonth() / 3);
      gte = new Date(now.getFullYear(), currentQuarter * 3, 1);
      lt = new Date(now.getFullYear(), (currentQuarter + 1) * 3, 1);
      break;
    }
    case 'Year':
      gte = new Date(now.getFullYear(), 0, 1);
      lt = new Date(now.getFullYear() + 1, 0, 1);
      break;
    case 'Custom':
      if (start && end) {
        gte = new Date(start);
        lt = new Date(end);
        lt.setDate(lt.getDate() + 1);
      }
      break;
    default:
      return null;
  }

  return { gte, lt };
};

module.exports = { getDateRangeFilter };
