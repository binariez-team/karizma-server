const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/UserModel");

// ******************************************* Profile Methods ***********************************

// update profile username
exports.updateProfile = async (req, res, next) => {
	let user = req.user;
	let { new_username } = req.body;
	try {
		let [validateUser] = await User.getByIdAndUsername(
			user.user_id,
			new_username
		);
		if (validateUser) {
			res.status(406).send({ message: "Username already exists" });
		} else {
			let newUser = {
				user_id: user.user_id,
				username: new_username,
			};
			await User.update(newUser);
			let [result] = await User.getById(user.user_id);
			const token = jwt.sign(
				{
					user_id: result.user_id.toString(),
					new_username,
					user_type: result.user_type,
				},
				"$3a#_cJDUV-$QsRewWXcyH-Xdji8#%^$*(_ZkfNdI@#!D-Nv0E_M3a"
			);
			const updatedUser = {
				username: new_username,
				first_name: result.first_name,
				user_type: result.user_type,
				token: token,
			};
			res.status(200).send(updatedUser);
		}
	} catch (error) {
		next(error);
	}
};

// update profile password
exports.updatePassword = async (req, res, next) => {
	let user = req.user;
	let data = req.body;
	try {
		let [result] = await User.getByPassword(user.user_id);

		console.log(data);
		console.log(result.password);
		console.log(bcrypt.hashSync(data.current_password, 10));

		// console.log(b);
		// let currentHashPassword = bcrypt.hashSync(data.current_password, 10);
		const verified = bcrypt.compareSync(
			data.current_password,
			result.password
		);
		if (verified) {
			await User.updatePassword(user.user_id, data.new_password);
			res.status(201).send({ message: "Password updated successfully!" });
		} else {
			res.status(406).send({ message: "old password is incorrect!" });
		}
	} catch (error) {
		next(error);
	}
};
