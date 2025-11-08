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

exports.getStockValue = async (req, res, next) => {
	try {
		const { user_id } = req.user;
		const result = await ReportModel.getStockValue(user_id);
		res.status(200).send(result);
	} catch (error) {
		next(error);
	}
};
