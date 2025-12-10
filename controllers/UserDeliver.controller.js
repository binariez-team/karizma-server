const User = require("../models/UserModel");

// get users
exports.getUsers = async (req, res, next) => {
    try {
        const { database_id } = req.user;
        let users = await User.getAllByUser(database_id);
        res.status(200).send(users);
    } catch (error) {
        next(error);
    }
};
