const pool = require("../config/database");

class Category {
	// get all categories
	static async getAll() {
		const [rows] = await pool.query(
			`SELECT * FROM products_categories WHERE is_deleted = 0 ORDER BY category_index ASC`
		);
		return rows;
	}

	// get by id
	static async getById(id) {
		const [[rows]] = await pool.query(
			`SELECT * FROM products_categories WHERE category_id = ?`,
			id
		);
		return rows;
	}

	// sort categories
	// parameterized: values were interpolated into SQL with multipleStatements on
	static async sort(categories) {
		let query = "";
		const params = [];
		categories.forEach((element) => {
			const categoryId = element.category_id;
			// a plain object bound to ? is expanded by mysql2 into `key` = value
			// pairs (rewriting the WHERE); the old text form errored on it anyway
			if (
				categoryId !== null &&
				typeof categoryId === "object" &&
				!Array.isArray(categoryId)
			) {
				throw new Error("Invalid category_id");
			}
			query += `UPDATE products_categories SET category_index = ? WHERE category_id = ?;`;
			params.push(categories.indexOf(element), categoryId);
		});
		await pool.query(query, params);
	}

	// create category
	static async create(category) {
		// create max index for category_index
		const [[{ category_index }]] = await pool.query(
			`SELECT IFNULL(MAX(category_index) + 1, 0) AS category_index FROM products_categories`
		);
		category.category_index = category_index;

		// insert new category
		const [rows] = await pool.query(
			`INSERT INTO products_categories SET ?`,
			category
		);
		return rows;
	}

	// update category
	static async update(category) {
		await pool.query(
			`UPDATE products_categories SET ? WHERE category_id = ?`,
			[category, category.category_id]
		);
	}

	// delete category
	static async delete(id) {
		await pool.query(
			`UPDATE products_categories SET is_deleted = 1 WHERE category_id = ?`,
			id
		);
	}
}

module.exports = Category;
