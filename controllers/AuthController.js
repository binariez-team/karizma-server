const jwt = require("jsonwebtoken");
const User = require("../models/UserModel");

exports.login = async (req, res, next) => {
	const io = req.io;
	try {
		const { username, password } = req.body;

		if (!(username && password)) {
			res.status(400).send("All fields are required!");
		}
		let results = await User.getByUsernameAndPassword(username, password);
		if (results) {
			const token = jwt.sign(
				{
					user_id: results.user_id.toString(),
					username,
					user_type: results.user_type,
				},
				"$3a#_cJDUV-$QsRewWXcyH-Xdji8#%^$*(_ZkfNdI@#!D-Nv0E_M3a"
			);

			const user = {
				username: username,
				user_type: results.user_type,
				token: token,
			};
			io.emit("userLoggedIn", username);
			res.status(200).send(user);
		} else {
			res.status(401).send("Incorrect username or password!");
		}
	} catch (error) {
		next(error);
	}
};
