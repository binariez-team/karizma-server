const User = require("../models/UserModel");

// get users
exports.getUsers = async (req, res, next) => {
	try {
		const user = req.user;
		let users = await User.getAllByUser(user.user_id);
		res.status(200).send(users);
	} catch (error) {
		next(error);
	}
};
