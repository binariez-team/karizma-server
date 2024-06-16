const User = require("../models/UserModel");

// get users
exports.getUsers = async (req, res, next) => {
	try {
		let users = await User.getAll();
		res.status(200).send(users);
	} catch (error) {
		next(error);
	}
};

// create user
exports.createUser = async (req, res, next) => {
	let user = req.body;
	delete user.user_ID;
	delete user.confirm_password;
	try {
		// validate if username already taken
		let [validateUser] = await User.getByUsername(user.username);
		if (validateUser) {
			res.status(406).send({ message: "Username already exists" });
		} else {
			// create user
			let result = await User.create(user);
			let [createdUser] = await User.getById(result.insertId);
			res.status(201).send(createdUser);
		}
	} catch (error) {
		next(error);
	}
};

// update user
exports.updateUser = async (req, res, next) => {
	let user = req.body;
	delete user.password;
	delete user.confirm_password;
	try {
		let [validateUser] = await User.getByIdAndUsername(
			user.user_id,
			user.username
		);
		if (validateUser) {
			res.status(406).send({ message: "Username already exists" });
		} else {
			await User.update(user);
			const [updatedUser] = await User.getById(user.user_id);
			res.status(201).send(updatedUser);
		}
	} catch (error) {
		next(error);
	}
};

// delete user
exports.deleteUser = async (req, res, next) => {
	let user_id = req.params.id;
	console.log(user_id);
	try {
		await User.delete(user_id);
		res.status(201).send({ message: "User deleted successfully!" });
	} catch (error) {
		next(error);
	}
};
