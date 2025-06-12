require("dotenv").config();
const oracledb = require("oracledb");

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const db = {
  get: async () => {
    return await oracledb.getConnection({
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      connectString: process.env.DB_CONNECT,
    });
  },
};

module.exports = db;
