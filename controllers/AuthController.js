const jwt = require("jsonwebtoken");
const User = require("../models/UserModel");

exports.login = async (req, res, next) => {
	const io = req.io;
	try {
		const { username, password } = req.body;

		if (!(username && password)) {
			res.status(400).send("All fields are required!");
		}
		let result = await User.getByUsernameAndPassword(username, password);
		if (result) {
			const token = jwt.sign(
				{
					user_id: result.user_id.toString(),
					username,
					user_type: result.user_type,
				},
				"$3a#_cJDUV-$QsRewWXcyH-Xdji8#%^$*(_ZkfNdI@#!D-Nv0E_M3a"
			);

			const user = {
				username: username,
				first_name: result.first_name,
				user_type: result.user_type,
				token: token,
			};
			if (user.user_type !== "admin") {
				io.emit("userLoggedIn", username);
			}
			res.status(200).send(user);
		} else {
			res.status(401).send("Incorrect username or password!");
		}
	} catch (error) {
		next(error);
	}
};
