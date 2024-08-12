const pool = require("../config/database");

class Brand {
	// get all brands
	static async getAll() {
		const [rows] = await pool.query(
			`SELECT * FROM products_brands WHERE is_deleted = 0`
		);
		return rows;
	}

	// get by id
	static async getById(id) {
		const [[rows]] = await pool.query(
			`SELECT * FROM products_brands WHERE brand_id = ?`,
			id
		);
		return rows;
	}

	// sort brands
	// static async sort(brands) {
	// 	let query = "";
	// 	brands.forEach((element) => {
	// 		query += `UPDATE products_brands SET brand_index = ${brands.indexOf(
	// 			element
	// 		)} WHERE brand_id = ${element.brand_id};`;
	// 	});
	// 	await pool.query(query);
	// }

	// create brand
	static async create(brand) {
		// create max index for brand_index
		// const [[{ brand_index }]] = await pool.query(
		// 	`SELECT IFNULL(MAX(brand_index) + 1, 0) AS brand_index FROM products_brands`
		// );
		// brand.brand_index = brand_index;

		// insert new brand
		const [rows] = await pool.query(
			`INSERT INTO products_brands SET ?`,
			brand
		);
		return rows;
	}

	// update brand
	static async update(brand) {
		await pool.query(`UPDATE products_brands SET ? WHERE brand_id = ?`, [
			brand,
			brand.brand_id,
		]);
	}

	// delete brand
	static async delete(id) {
		await pool.query(
			`UPDATE products_brands SET is_deleted = 1 WHERE brand_id = ?`,
			id
		);
	}
}

module.exports = Brand;
