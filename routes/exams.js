const express = require('express');
const Exam = require("../models/exam");
const User = require("../models/user");
const wrapAsync = require("../utils/wrapAsync.js");
const { validateExam, isLoggedIn, authorizedRoles, schema } = require("../middleware.js");
const ExpressError = require('../utils/ExpressError.js');
const readxlsxFile = require("read-excel-file/node");
const Certificates = require("../models/certificate.js")
const { mongoose } = require("mongoose")

const path = require('path');
const pdf = require('html-pdf');
const ejs = require('ejs');

const axios = require("axios");
const fs = require("fs").promises;
const fs1 = require("fs");


const qs = require('qs');



const { upload_exam_notifications, multipleUpload, upload_exam_results } = require("../storage.js")
const { s3Uploadv3ExamNotifications, getObjectSignedUrl, s3Uploadv3Signature, s3Uploadv3Challan, s3Uploadv3Results } = require("../s3service.js");
const exam = require('../models/exam');
const { examSchemaJoi } = require('../serverside_validation.js');


const router = express.Router();


const monthOrder = {
    January: 1,
    February: 2,
    March: 3,
    April: 4,
    May: 5,
    June: 6,
    July: 7,
    August: 8,
    September: 9,
    October: 10,
    November: 11,
    December: 12
};

//GET Route  - DONE
router.get("/", wrapAsync(async(req, res) => {
    let availableExams;
    if (req.user && req.user.role === "Student") {
        availableExams = await Exam.find({ course: req.user.course, isRegistrationOpen: true })
    } else if (req.user && req.user.role === "Admin" || req.user && req.user.role === "clerk") {
        availableExams = await Exam.find({});
    } else {
        availableExams = await Exam.find({ isRegistrationOpen: true });
    }


    availableExams.sort((a, b) => {
        const yearDiff = parseInt(b.year) - parseInt(a.year);
        if (yearDiff !== 0) return yearDiff;

        return monthOrder[b.month] - monthOrder[a.month];
    });
    res.render("exams/index.ejs", { availableExams });
}))


//NEW Route - DONE
router.get("/new", authorizedRoles("Admin"), isLoggedIn, (req, res) => {
    console.log(res.locals.currUser)
    res.render("exams/new.ejs");
})

//CREATE ROUTE -DONE
router.post("/", isLoggedIn, authorizedRoles("Admin"), upload_exam_notifications.single("notification"), wrapAsync(async(req, res) => {

    const { error, value } = examSchemaJoi.validate(req.body.exam);
    if (error) {
        req.flash("error", `Validation Error: ${error.details[0].message}`);
        return res.redirect("/exams/new");
    }

    /*let exam = req.body.exam;
    console.log(exam)*/


    const resp = await s3Uploadv3ExamNotifications(req.file);
    console.log(resp);
    /*const uri = await getObjectSignedUrl(resp);
    console.log(uri)*/
    const uri = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${resp}`;



    // console.log(url, +"   ", filename);
    const newExam = new Exam(value);
    newExam.notification = uri;

    await newExam.save();
    res.redirect('/exams');

}));



//Show Route -DONE
router.get("/:id", isLoggedIn, authorizedRoles("Admin", "clerk"), wrapAsync(async(req, res) => {
    let { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid Exam ID");
        return res.redirect("/exams"); // or a 400 response
    }
    const exam = await Exam.findById(id);
    if (!exam) {
        req.flash("error", "Exam not found");
        return res.redirect("/exams");
    }
    res.render('exams/show.ejs', { exam });
}))


//EDIT ROUTE - DONE
router.get("/:id/edit", isLoggedIn, authorizedRoles("Admin"), wrapAsync(async(req, res) => {
    let { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        // Invalid id, respond with 400 or render error page
        req.flash("error", "Invalid exam ID");
        return res.redirect("/exams");
    }

    const exam = await Exam.findById(id);
    if (!exam) {
        req.flash("error", "Exam not found");
        return res.redirect("/exams");
    }
    res.render('exams/edit.ejs', { exam });
}))

//UPDATE ROUTE -DONE
router.put("/:id", isLoggedIn, authorizedRoles("Admin"), wrapAsync(async(req, res) => {
    let { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid exam ID");
        return res.redirect("/exams");
    }

    await Exam.findByIdAndUpdate(id, {...req.body.exam });

    res.redirect(`/exams/${id}`);
}))


//DELETE ROUTE  -DONE
router.delete("/:id", isLoggedIn, authorizedRoles("Admin"), wrapAsync(async(req, res) => {
    let { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid exam ID");
        return res.redirect("/exams");
    }
    let deletedExam = await Exam.findByIdAndDelete(id);
    if (!deletedExam) {
        req.flash("error", "Exam not found");
        return res.redirect("/exams");
    }

    res.redirect(`/exams`);
}))


//DONE
router.post('/:id/stop-registration', isLoggedIn, authorizedRoles("Admin"), wrapAsync(async(req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error', 'Invalid exam ID');
        return res.redirect('/exams');
    }
    await Exam.findByIdAndUpdate(id, { isRegistrationOpen: false });
    req.flash('success', 'Registrations have been stopped for this exam.');
    res.redirect('/exams');
}))


//DONE
router.get("/:id/registrations", isLoggedIn, authorizedRoles("clerk"), wrapAsync(async(req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error', 'Invalid Exam ID');
        return res.redirect('/exams');
    }
    const exam = await Exam.findById(id).populate("registeredStudents.studentId");

    const currStudents = exam.registeredStudents.map(s => {
        const student = s.studentId;
        const registration = student.examRegistrations.find(reg => reg.examId.equals(id));
        let d = registration.appliedAt;
        const date = new Date(d);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-based
        const year = String(date.getFullYear()).slice(-2); // Get last 2 digits of year
        d = `${day}/${month}/${year}`;

        return {
            _id: student._id,
            name: student.name,
            rollNumber: student.rollNumber,
            branch: student.branch,
            email: student.email,
            image: student.image,
            challan_pdf: registration.challan_pdf,
            signature: registration.signature,
            subjects: registration.subjects,
            appliedAt: d,

            status_of_application: registration.status_of_application
                //signature: registration && registration.signature ? 
        };
    });
    currStudents.sort((a, b) => {
        if (a.branch < b.branch) return -1;
        if (a.branch > b.branch) return 1;
        if (a.rollNumber < b.rollNumber) return -1;
        if (a.rollNumber > b.rollNumber) return 1;
        return 0;
    });



    return res.render("exams/verify_registation.ejs", { students: currStudents, exam });

}))



//done
router.get("/:id/registrations/subjects", isLoggedIn, authorizedRoles("clerk"), wrapAsync(async(req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error', 'Invalid Exam ID');
        return res.redirect('/exams');
    }
    const exam = await Exam.findById(id).populate("registeredStudents.studentId");

    const currStudents = exam.registeredStudents.map(s => {
        const student = s.studentId;
        const registration = student.examRegistrations.find(reg => reg.examId.equals(id));

        return {
            _id: student._id,
            name: student.name,
            rollNumber: student.rollNumber,
            image: student.image,
            branch: student.branch,
            subjects: registration.subjects,

            status_of_application: registration.status_of_application
                //signature: registration && registration.signature ? 
        };
    });
    currStudents.sort((a, b) => {
        if (a.branch < b.branch) return -1;
        if (a.branch > b.branch) return 1;
        if (a.rollNumber < b.rollNumber) return -1;
        if (a.rollNumber > b.rollNumber) return 1;
        return 0;
    });



    return res.render("exams/regular_subjects.ejs", { students: currStudents, exam });

}))



//done
router.get("/:id/revaluation_registrations", isLoggedIn, authorizedRoles("clerk"), wrapAsync(async(req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error', 'Invalid Exam ID');
        return res.redirect('/exams');
    }

    // Find all students who have registered for this exam and applied for revaluation
    const students = await User.find({
        "examRegistrations": {
            $elemMatch: { examId: id, applyForRevaluation: true }
        }
    });


    students.sort((a, b) => {
        if (a.branch < b.branch) return -1;
        if (a.branch > b.branch) return 1;
        if (a.rollNumber < b.rollNumber) return -1;
        if (a.rollNumber > b.rollNumber) return 1;
        return 0;
    });


    const exam = await Exam.findById(id);
    return res.render("exams/verify_revaluation_registation.ejs", { students, exam });
}))



//done
router.get("/:id/revaluation_registrations/subjects", isLoggedIn, authorizedRoles("clerk"), wrapAsync(async(req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error', 'Invalid Exam ID');
        return res.redirect('/exams');
    }


    // Find all students who have registered for this exam and applied for revaluation
    const students = await User.find({
        "examRegistrations": {
            $elemMatch: { examId: id, applyForRevaluation: true }
        }
    });


    students.sort((a, b) => {
        if (a.branch < b.branch) return -1;
        if (a.branch > b.branch) return 1;
        if (a.rollNumber < b.rollNumber) return -1;
        if (a.rollNumber > b.rollNumber) return 1;
        return 0;
    });


    const exam = await Exam.findById(id);
    return res.render("exams/revaluation_subjects.ejs", { students, exam });
}))


//done
router.post("/:id/registrations", isLoggedIn, authorizedRoles("clerk"), wrapAsync(async(req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid Exam ID");
        return res.redirect("/exams");
    }

    const { studentIds } = req.body; // Array of student IDs

    if (!Array.isArray(studentIds) || studentIds.some(sid => !mongoose.Types.ObjectId.isValid(sid))) {
        req.flash("error", "Invalid student ID(s) in submission.");
        return res.redirect(`/exams/${id}/registrations`);
    }

    // Extract statuses for each student
    let updatedRegistrations = studentIds.map(studentId => {
        return {
            studentId,
            status_of_application: req.body[`status_${studentId}`] // Get selected status
        };
    });

    // console.log(updatedRegistrations);

    for (let reg of updatedRegistrations) {
        await User.updateOne({ _id: reg.studentId, "examRegistrations.examId": id }, { $set: { "examRegistrations.$.status_of_application": reg.status_of_application } });
    }

    req.flash("success", "Registrations updated successfully!");
    res.redirect(`/exams/${id}/registrations`);

}))


//done
router.post("/:id/revaluation_registrations", isLoggedIn, authorizedRoles("clerk"), wrapAsync(async(req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid Exam ID");
        return res.redirect("/exams");
    }

    const { studentIds } = req.body; // Array of student IDs

    if (!Array.isArray(studentIds) || studentIds.some(sid => !mongoose.Types.ObjectId.isValid(sid))) {
        req.flash("error", "Invalid Student ID(s)");
        return res.redirect("/exams");
    }

    // Extract statuses for each student
    let updatedRegistrations = studentIds.map(studentId => {
        return {
            studentId,
            status_of_revaluation_application: req.body[`status_${studentId}`] // Get selected status
        };
    });

    // console.log(updatedRegistrations);

    for (let reg of updatedRegistrations) {
        await User.updateOne({ _id: reg.studentId, "examRegistrations.examId": id }, { $set: { "examRegistrations.$.status_of_revaluation_application": reg.status_of_revaluation_application } });
    }

    req.flash("success", "Revaluation Status updated successfully!");
    res.redirect(`/exams`);

}))



//done
router.get("/:id/students/:studentId", isLoggedIn, wrapAsync(async(req, res) => {
    const { id, studentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(studentId)) {
        req.flash('error', 'Invalid Exam or Student ID');
        return res.redirect('/exams');
    }

    const student = await User.findById(studentId);
    const exam = await Exam.findById(id);
    if (!exam || !student) {
        req.flash('error', 'Exam or Student not found');
        return res.redirect('/exams');
    }

    return res.render("users/registration_form.ejs", { exam, student });
}))





//done
router.post("/:id/students/:studentId", isLoggedIn, multipleUpload, wrapAsync(async(req, res) => {

    const { id, studentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(studentId)) {
        req.flash('error', 'Invalid Exam or Student ID');
        return res.redirect('/exams');
    }

    const { name, fatherName, email, branch, rollNumber, DOB, gender, yearOfExam, monthOfExam, totalSubjects, subjects, amountPaid, challanNumber, dateOfPayment, image, station, appliedAt } = req.body.student;

    //console.log(subjects);
    const student = await User.findByIdAndUpdate(studentId, { name, fatherName, email, branch, DOB, gender });
    if (!student) {
        req.flash('error', 'Student not found');
        return res.redirect('/exams');
    }

    const exam = await Exam.findById(id);
    if (!exam) {
        req.flash('error', 'Exam not found');
        return res.redirect('/exams');
    }

    let semester = exam.semester

    //student.role = "Student";
    let alreadyRegistered = false;

    student.examRegistrations.forEach((exm) => {
        if (exm.examId.toString() === id) {
            alreadyRegistered = true;
        }
    })

    if (!alreadyRegistered) {

        const resp = await s3Uploadv3Signature(req.files.signature[0]);
        // console.log(resp);
        const uri = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${resp}`;
        // const uri = await getObjectSignedUrl(resp);
        console.log(uri)

        const resp2 = await s3Uploadv3Challan(req.files.challan[0]);
        console.log(resp2);
        const uri2 = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${resp2}`;
        // const uri2 = await getObjectSignedUrl(resp2);
        console.log(uri2)



        student.examRegistrations.push({
            examId: id,
            challan_pdf: uri2,
            signature: uri,
            yearOfExam,
            monthOfExam,
            totalSubjects,
            subjects,
            amountPaid,
            challanNumber,
            station,
            dateOfPayment,
            appliedAt,
            semester


        })

        await student.save();

        const exam = await Exam.findByIdAndUpdate(id);
        exam.registeredStudents.push({
            studentId: studentId
        })

        await exam.save();
        return res.redirect("/exams");
    } else {
        req.flash("error", "Already applied for this exam");
        return res.redirect("/exams");
    }
}))


//done
router.get("/:id/postresults", authorizedRoles("Admin"), wrapAsync(async(req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error', 'Invalid Exam ID');
        return res.redirect('/exams');
    }

    // Find the exam with populated student details and exam registrations
    const exam = await Exam.findById(id)
        .populate('registeredStudents.studentId', 'name rollNumber branch examRegistrations');

    if (!exam) {
        return res.status(404).send('Exam not found');
    }
    res.render("results/postresults.ejs", { exam: exam });
}))


//done
router.post("/:id/postresults", authorizedRoles("Admin"), upload_exam_results.single("exam[results]"), wrapAsync(async(req, res) => {
    const { id } = req.params; // Exam ID from the route parameter
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash('error', 'Invalid Exam ID');
        return res.redirect('/exams');
    }

    const exam = await Exam.findById(id);
    if (!exam) {
        return res.status(404).send({ message: "Exam not found." });
    }



    const resp = await s3Uploadv3Results(req.file);
    console.log(resp);
    const uri = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${resp}`;
    //const uri = await getObjectSignedUrl(resp);
    console.log(uri)


    exam.results_excel_sheet = uri;
    exam.isResultsDeclared = true;
    exam.results_declared_at = Date.now();

    await exam.save();

    console.log(`File uploaded successfully: ${req.file.filename}`);

    req.flash("success", "Results Declared Successfully!");
    res.redirect(`/exams`);
}));



async function downloadFromS3(s3Url, outputFile) {
    const response = await axios.get(s3Url, { responseType: "arraybuffer" });
    await fs.writeFile(outputFile, response.data);
    return outputFile;
}

//done
router.get("/:id/results/:studentId", isLoggedIn, authorizedRoles("Student"), wrapAsync(async(req, res) => {
    const { id, studentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(studentId)) {
        req.flash("error", "Invalid Exam or Student ID");
        return res.redirect("/exams");
    }

    const student = await User.findById(studentId);
    const exam = await Exam.findById(id);
    if (!student || !exam) {
        req.flash("error", "Exam or Student not found");
        return res.redirect("/exams");
    }

    if (exam.isResultsDeclared) {

        const s3Url = exam.results_excel_sheet; // Ensure this is a signed S3 URL

        // Create a temporary path to save the file
        const tempFilePath = path.join(__dirname, "..", "temp_results.xlsx");

        await downloadFromS3(s3Url, tempFilePath);
        console.log("File downloaded successfully:", tempFilePath);

        const rows = await readxlsxFile(tempFilePath, { schema, sheet: "Sheet1" });
        // const rows = await readxlsxFile(tempFilePath);
        console.log(rows)



        const result = rows.rows;
        console.log(result);

        const studentResult = [];
        result.forEach((row) => {

            if (row.ROLL_NUMBER && student.rollNumber && row.ROLL_NUMBER.toString() == student.rollNumber.toString()) {

                studentResult.push({
                    name: row.NAME,
                    branch: row.BRANCH,
                    roll_number: row.ROLL_NUMBER,
                    subject: row.SUBNAME,
                    grade: row.GRADE,
                    subcode: row.SUBCODE,
                    gp: row.GP,
                    credits: row.CREDITS
                })
            }

        })

        console.log(studentResult)


        const date = new Date(exam.results_declared_at);
        date.setDate(date.getDate() + 5); // Add 5 days for revaluation

        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = String(date.getFullYear()).slice(-2);

        const formattedDate = `${day}/${month}/${year}`;

        // Convert formatted date to a valid Date object for comparison
        const revaluationDeadline = new Date(`20${year}`, month - 1, day);
        const currentDate = new Date();

        const revaluationDisabled = currentDate > revaluationDeadline; // Boolean flag


        console.log("Revaluation Deadline:", revaluationDeadline);
        console.log("Current Date:", currentDate);
        console.log("Is Revaluation Disabled:", revaluationDisabled);


        return res.render("results/viewresults.ejs", { studentResult, exam, student, revaluationDisabled, revaluationDeadline: formattedDate });

    }
    req.flash("error", "Results are not yet Declared");
    res.redirect(`/exams`);
}))


//done
router.get("/:id/re_evaluation/:studentId", isLoggedIn, authorizedRoles("Student"), wrapAsync(async(req, res) => {
    const { id, studentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(studentId)) {
        req.flash("error", "Invalid Exam or Student ID");
        return res.redirect("/exams");
    }

    const student = await User.findById(studentId).populate("examRegistrations", "subjects");
    const exam = await Exam.findById(id);

    if (!student || !exam) {
        req.flash("error", "Exam or Student not found");
        return res.redirect("/exams");
    }

    if (exam.isResultsDeclared) {
        return res.render("results/apply_for_re_evaluation.ejs", { exam, student });
    } else {
        req.flash("error", "You haven't applied for this exam");
        res.redirect(`/exams`);
    }
}))




//done
router.post("/:id/re_evaluation/:studentId", isLoggedIn, authorizedRoles("Student"), multipleUpload, wrapAsync(async(req, res) => {
    //return res.json(req.body)
    const { id, studentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(studentId)) {
        req.flash("error", "Invalid Exam or Student ID");
        return res.redirect("/exams");
    }


    const { student } = req.body;


    // Extract subjects from the request
    const subjects = student.subjects;

    // Fetch the student from the database
    const stu = await User.findById(studentId);
    if (!stu) {
        req.flash("error", "Student not found.");

    }


    const examRegistration = stu.examRegistrations.find(reg => reg.examId.toString() === id);
    if (!examRegistration) {
        req.flash("error", "Exam registration not found.");

    }
    examRegistration.applyForRevaluation = true;


    const resp = await s3Uploadv3Signature(req.files.signature[0]);
    // console.log(resp);
    // const uri = await getObjectSignedUrl(resp);
    const uri = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${resp}`;
    console.log(uri)

    const resp2 = await s3Uploadv3Challan(req.files.challan[0]);
    console.log(resp2);
    //const uri2 = await getObjectSignedUrl(resp2);
    const uri2 = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${resp2}`;
    console.log(uri2)


    examRegistration.reEvaluationSubjects = subjects;

    examRegistration.revaluation_challan_pdf = uri2;
    examRegistration.revaluation_signature = uri;

    examRegistration.revaluation_bank_name = student.bank
    examRegistration.revaluation_challanNumber = student.challanNumber
    examRegistration.revaluation_amountPaid = student.amountPaid



    let stu1 = await stu.save();

    res.redirect(`/exams`);
}));


//done
router.get("/:id/postrevaluationResults", authorizedRoles("Admin"), wrapAsync(async(req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid Exam ID");
        return res.redirect("/exams");
    }
    const exam = await Exam.findById(id);

    if (!exam) {
        req.flash("error", "Exam not found.");
        res.redirect("/exams");
    }


    res.render("results/postrevaluationresults.ejs", { exam: exam })
}));


//done
router.post("/:id/postrevaluationresults", authorizedRoles("Admin"), upload_exam_results.single("exam[revaluationResults]"), wrapAsync(async(req, res) => {
    const { id } = req.params; // Exam ID from the route parameter
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid Exam ID");
        return res.redirect("/exams");
    }
    const exam = await Exam.findById(id);
    if (!exam) {
        return res.status(404).send({ message: "Exam not found." });
    }

    const resp = await s3Uploadv3Results(req.file);
    console.log(resp);
    //const uri = await getObjectSignedUrl(resp);
    const uri = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${resp}`;
    console.log(uri)


    exam.isRevaluationResultsDeclared = true;
    exam.reEvaluationResults_excel_sheet = uri;

    await exam.save();
    console.log(`File uploaded successfully: ${req.file.filename}`);

    req.flash("success", "Results Declared Successfully!");
    res.redirect(`/exams`);

}));


//done
router.get("/:id/revaluation_results/:studentId", isLoggedIn, authorizedRoles("Student"), wrapAsync(async(req, res) => {
    const { id, studentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(studentId)) {
        req.flash("error", "Invalid Exam or Student ID");
        return res.redirect("/exams");
    }
    const student = await User.findById(studentId);
    const exam = await Exam.findById(id);
    if (!student || !exam) {
        req.flash("error", "Exam or Student not found");
        return res.redirect("/exams");
    }

    if (exam.isRevaluationResultsDeclared) {
        const s3Url = exam.reEvaluationResults_excel_sheet; // Ensure this is a signed S3 URL

        // Create a temporary path to save the file
        const tempFilePath = path.join(__dirname, "..", "temp1_results.xlsx");

        await downloadFromS3(s3Url, tempFilePath);
        console.log("File downloaded successfully:", tempFilePath);

        const rows = await readxlsxFile(tempFilePath, { schema, sheet: "Sheet1" });
        const result = rows.rows;
        const studentResult = [];
        result.forEach((row) => {

            if (row.ROLL_NUMBER && student.rollNumber && row.ROLL_NUMBER.toString() == student.rollNumber.toString()) {

                studentResult.push({
                    name: row.NAME,
                    branch: row.BRANCH,
                    roll_number: row.ROLL_NUMBER,
                    subject: row.SUBNAME,
                    grade: row.GRADE,
                    subcode: row.SUBCODE,
                    gp: row.GP,
                    credits: row.CREDITS
                })
            }
        })
        return res.render("results/re_evaluation_results.ejs", { studentResult, exam, student });

    }
    req.flash("error", "Results are not yet Declared");
    res.redirect(`/exams`);
}))


async function fetchImageBase64(imageUrl) {
    try {
        const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
        const base64 = Buffer.from(response.data, "binary").toString("base64");
        return `data:image/jpeg;base64,${base64}`; // Adjust MIME type if necessary
    } catch (error) {
        console.error("Error fetching image:", error);
        return "";
    }
}


//done

router.get('/generate-hall-ticket/:userId/:examId', async(req, res) => {
    try {
        const { userId, examId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(userId) || !mongoose.Types.ObjectId.isValid(examId)) {
            return res.status(400).send('Invalid User ID or Exam ID');
        }


        // Find user and exam data
        const user = await User.findById(userId);
        const exam = await Exam.findById(examId);

        if (!user || !exam) {
            return res.status(404).send('User or Exam not found');
        }

        // Find the specific exam registration
        const registration = user.examRegistrations.find(
            reg => reg.examId.toString() === examId
        );

        if (!registration) {
            return res.status(404).send('Exam registration not found');
        }

        let base64Image = '';
        if (user.image) {
            base64Image = await fetchImageBase64(user.image);
        }


        // Render the EJS template with data
        ejs.renderFile(
            path.join(__dirname, "../", 'views', "users", 'hall-ticket.ejs'), { user, exam, registration, base64Image },
            (err, html) => {
                if (err) {
                    return res.send(err);
                }

                // PDF Configuration
                const options = {
                    format: 'A4',
                    border: {
                        top: '10mm',
                        right: '10mm',
                        bottom: '10mm',
                        left: '10mm'
                    },
                    footer: {
                        height: '0mm'
                    },
                    renderDelay: 1000,
                    pageRanges: '1'
                };

                // Generate PDF
                pdf.create(html, options).toBuffer((err, buffer) => {
                    if (err) {
                        return res.status(500).send(err);
                    }

                    // Send the PDF as a response
                    //res.type('application/pdf');
                    res.setHeader('Content-Disposition', `attachment; filename="Hall_Ticket_${user.name}.pdf"`);
                    res.setHeader('Content-Type', 'application/pdf');

                    res.send(buffer);
                });
            }
        );
    } catch (error) {
        console.error('Error generating hall ticket:', error);
        res.status(500).send('Error generating hall ticket');
    }
});




router.get('/:studentId/dashboard', isLoggedIn, authorizedRoles("Student"), wrapAsync(async(req, res) => {

        const { studentId } = req.params;
        // Validate student ID if you want (optional)
        if (!mongoose.Types.ObjectId.isValid(studentId)) {
            req.flash('error', 'Invalid student ID');
            return res.redirect('/login'); // or wherever makes sense
        }


        const student = await User.findById(studentId).populate({
            path: 'examRegistrations.examId', // Populate the examId field in examRegistrations
            // select: 'isResultsDeclared semester month year' // Select fields you need from the Exam model
        });

        // return res.json(student.examRegistrations)
        const exams = student.examRegistrations

        const bonafideCertificate = await Certificates.findOne({ student: studentId, typeOfCertificate: "Bonafide" });
        const custodianCertificate = await Certificates.findOne({ student: studentId, typeOfCertificate: "Custodian" });
        const courseCompletionCertificate = await Certificates.findOne({ student: studentId, typeOfCertificate: "Course Completion" });
        console.log(bonafideCertificate, custodianCertificate, courseCompletionCertificate)

        return res.render("users/dashboard.ejs", {
            examData: exams,
            student,
            bonafideCertificate,
            custodianCertificate,
            courseCompletionCertificate
        });
    }

));


module.exports = router;