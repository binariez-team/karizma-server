const ReportModel = require("../models/ReportModel");

exports.getTotalSales = async (req, res, next) => {
	try {
		const { start, end } = req.params;
		const user_id = req.user.user_id;
		const result = await ReportModel.getTotalSales(user_id, start, end);
		res.status(200).json(result);
	} catch (error) {
		next(error);
	}
};
