// const getPKTDate = () => {
//   return new Date();
// };

// module.exports = {
//   getPKTDate
// };


const getPKTDate = (date = new Date()) => {
  return new Date(date.getTime());
};

const formatPKTDate = (date) => {
  if (!date) return 'N/A';
  const d = new Date(date);
  return d.toLocaleString('en-US', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
};

module.exports = {
  getPKTDate,
  formatPKTDate
};
