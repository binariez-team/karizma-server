const mysql = require("mysql2/promise");

if (process.env.NODE_ENV === "production") {
	var pool = mysql.createPool({
		connectionLimit: 10,
		host: "209.172.2.50",
		user: "karizmam_app",
		password: ",Yqv(j93q]4w",
		database: "karizmam_karizma",
		multipleStatements: true,
		dateStrings: true,
	});
} else {
	var pool = mysql.createPool({
		connectionLimit: 10,
		host: "localhost",
		user: "root",
		password: "roottoor",
		database: "karizma",
		multipleStatements: true,
		dateStrings: true,
	});
}

pool.getConnection(async (err, connection) => {
	if (err) {
		if (err.code === "PROTOCOL_CONNECTION_LOST") {
			console.error("Database connection was closed.");
		}
		if (err.code === "ER_CON_COUNT_ERROR") {
			console.error("Database has too many connections.");
		}
		if (err.code === "ECONNREFUSED") {
			console.error("Database connection was refused.");
		}
	}
	if (connection) await connection.release();
	return;
});

module.exports = pool;