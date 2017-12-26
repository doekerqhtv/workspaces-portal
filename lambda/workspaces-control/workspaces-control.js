'use strict';

// Load the AWS SDK for Node.js
var AWS = require('aws-sdk');
// Set the region 
AWS.config.update({
    region: 'us-east-1'
});

// Create the WorkSpaces service object
var workspaces = new AWS.WorkSpaces({
    apiVersion: '2015-04-08'
});

// Create the Step Functions service object
var stepfunctions = new AWS.StepFunctions();

exports.handler = (event, context, callback) => {

    var originURL = process.env.ORIGIN_URL || '*'; // Origin URL to allow for CORS
    var stateMachine = process.env.STATE_MACHINE_ARN || 'arn:aws:states:us-east-1:375301133253:stateMachine:PromotionApproval'; // State Machine for 'create' action.

    console.log('Received event:', JSON.stringify(event, null, 2)); // Output log for debugging purposes.

    // The 'action' parameter specifies what workspaces control should do. Accepted values: list, create, rebuild, reboot, delete.
    var action = JSON.parse(event.body)["action"]; 
    console.log("action: " + action);

    if (action == "list") {
        // 'list' handles outputting the WorkSpace details assigned to the user that submits the API call. 
        // If no workspace is found, currently just responds with an error which is handled client-side.
    
        // The 'email' value within the Cognito token is used to determine ownership, which is checked agaisnt the 'SelfServiceManaged' tag value.
        // The tag value is used for ownership detection in order to avoid integrating with Directory Services directly.
        console.log("Trying to find desktop owned by: " + event.requestContext.authorizer.claims.email); 

        var params = [];

        // Obtain a list of all WorkSpaces, then parse the returned list to find the one with a 'SelfServiceManaged' tag
        // that equals the email address of the Cognito token, then take the ID of that WorkSpace and return all of its details back.
        workspaces.describeWorkspaces(describeWorkspacesParams, function (err, data) {
            if (err) {
                console.log(err, err.stack); // an error occurred
            } else {
                for (var i = 0; i < data.Workspaces.length; i++) { 
                    var workspaceDetails = data[i];
                    var describeTagsParams = {
                        ResourceId: data.Workspaces[i].WorkspaceId 
                    };

                    workspaces.describeTags(describeTagsParams, function (err, data, workspaceDetails) {
                        if (err) {
                            console.log(err, err.stack);
                        } else {

                            for (var i = 0; i < data.TagList.length; i++) {

                                if (data.TagList[i].Key == "SelfServiceManaged" && data.TagList[i].Value == event.requestContext.authorizer.claims.email) {
                                    console.log("Desktop for '" + event.requestContext.authorizer.claims.email + "' found: " + describeTagsParams.ResourceId);

                                    var describeDetailsParams = {
                                        WorkspaceIds: [
                                            describeTagsParams.ResourceId
                                        ]
                                      };
                                      workspaces.describeWorkspaces(describeDetailsParams, function(err, data) {

                                        if(err) {
                                            console.log(err, err.stack);
                                        } else {
                                            console.log("Finally: " + data);
                                            callback(null, {
                                                "statusCode": 200,
                                                "body": JSON.stringify(data.Workspaces[0]),
                                                "headers": {
                                                    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                                                    "Access-Control-Allow-Methods": "GET,OPTIONS",
                                                    "Access-Control-Allow-Origin": originURL
                                                }
                                            });
                                        }
                                      });

                                }
                            }

                        }
                    });
                }

            }
        });

    } else if (action == "create") {
        // 'create' handles creation by initiating the Step Functions State Machine. The State Machine first sends an email
        // to the configured Approver email address with two links: one to approve and one to decline. If the Approver declines, 
        // the process ends. If the Approver approves, the next State Machine calls another Lambda function 'workspaces-create' that
        // actually handles creating the WorkSpace.

        var stepParams = {
            stateMachineArn: stateMachine, /* required */
            input: JSON.stringify({
                "requesterEmailAddress": event.requestContext.authorizer.claims.email,
                "requesterUsername": JSON.parse(event.body)["username"],
                "requesterBundle": JSON.parse(event.body)["bundle"]
            })
          };
          stepfunctions.startExecution(stepParams, function(err, data) {
            if (err) {
                console.log(err, err.stack);
            } else {
                console.log(data);
                callback(null, {
                    statusCode: 200,
                    body: JSON.stringify({
                        Result: data,
                    }),
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            }
          });
    } else if (action == "rebuild") {
        // 'rebuild' handles rebuilding the WorkSpace assigned to the user that submits the API call. 
        // A rebuild function resets the WorkSpace back to its original state. Applications or system settings changes
        // will be lost during a rebuild. The Data Drive is recreated from the last snapshot; snapshots are taken every 12 hours.

        console.log("Trying to find desktop owned by: " + event.requestContext.authorizer.claims.email);

        var describeWorkspacesParams = [];

        workspaces.describeWorkspaces(describeWorkspacesParams, function (err, data) {
            if (err) {
                console.log(err, err.stack); // an error occurred
            } else {

                for (var i = 0; i < data.Workspaces.length; i++) {

                    var describeTagsParams = {
                        ResourceId: data.Workspaces[i].WorkspaceId /* required */
                    };
                    workspaces.describeTags(describeTagsParams, function (err, data) {
                        if (err) {
                            console.log(err, err.stack);
                        } else {
                            for (var i = 0; i < data.TagList.length; i++) {
                                if (data.TagList[i].Key == "SelfServiceManaged" && data.TagList[i].Value == event.requestContext.authorizer.claims.email) {
                                    console.log("Desktop for '" + event.requestContext.authorizer.claims.email + "' found: " + describeTagsParams.ResourceId);
                                    console.log("Rebuilding desktop '" + describeTagsParams.ResourceId + " per request.");

                                    var rebuildParams = {
                                        RebuildWorkspaceRequests: [{
                                            WorkspaceId: describeTagsParams.ResourceId
                                        }]
                                    };

                                    console.log(JSON.stringify(rebuildParams));

                                    workspaces.rebuildWorkspaces(rebuildParams, function (err, data) {
                                        if (err) {
                                            console.log("Error: " + err);
                                            callback(null, {
                                                statusCode: 500,
                                                body: JSON.stringify({
                                                    Error: err,
                                                }),
                                                headers: {
                                                    'Access-Control-Allow-Origin': '*',
                                                },
                                            });
                                        } else {
                                            console.log("Result: " + JSON.stringify(data));
                                            
                                            callback(null, {
                                                "statusCode": 200,
                                                "body": JSON.stringify({
                                                    Result: data
                                                }),
                                                "headers": {
                                                    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                                                    "Access-Control-Allow-Methods": "GET,OPTIONS",
                                                    "Access-Control-Allow-Origin": originURL
                                                }
                                            });
                                        }
                                    });

                                }
                            }

                        }
                    });
                }

            }
        });

    } else if (action == "reboot") {
        // 'rebuild' handles rebooting the WorkSpace assigned to the user that submits the API call. 

        console.log("Trying to find desktop owned by: " + event.requestContext.authorizer.claims.email);

        var describeWorkspacesParams = [];

        workspaces.describeWorkspaces(describeWorkspacesParams, function (err, data) {
            if (err) {
                console.log(err, err.stack); // an error occurred
            } else {

                for (var i = 0; i < data.Workspaces.length; i++) {

                    var describeTagsParams = {
                        ResourceId: data.Workspaces[i].WorkspaceId /* required */
                    };
                    workspaces.describeTags(describeTagsParams, function (err, data) {
                        if (err) {
                            console.log(err, err.stack);
                        } else {

                            for (var i = 0; i < data.TagList.length; i++) {
                                if (data.TagList[i].Key == "SelfServiceManaged" && data.TagList[i].Value == event.requestContext.authorizer.claims.email) {
                                    console.log("Desktop for '" + event.requestContext.authorizer.claims.email + "' found: " + describeTagsParams.ResourceId);
                                    console.log("Rebooting desktop '" + describeTagsParams.ResourceId + " per request.");

                                    var rebootParams = {
                                        RebootWorkspaceRequests: [{
                                            WorkspaceId: describeTagsParams.ResourceId
                                        }]
                                    };

                                    console.log(JSON.stringify(rebootParams));

                                    workspaces.rebootWorkspaces(rebootParams, function (err, data) {
                                        if (err) {
                                            console.log("Error: " + err);
                                            callback(null, {
                                                statusCode: 500,
                                                body: JSON.stringify({
                                                    Error: err,
                                                }),
                                                headers: {
                                                    'Access-Control-Allow-Origin': '*',
                                                },
                                            });
                                        } else {
                                            console.log("Result: " + JSON.stringify(data));
                                            
                                            callback(null, {
                                                "statusCode": 200,
                                                "body": JSON.stringify({
                                                    Result: data
                                                }),
                                                "headers": {
                                                    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                                                    "Access-Control-Allow-Methods": "GET,OPTIONS",
                                                    "Access-Control-Allow-Origin": originURL
                                                }
                                            });
                                        }
                                    });

                                }
                            }

                        }
                    });
                }

            }
        });

    } else if (action == "delete") {
        // 'delete' handles deleting the WorkSpace assigned to the user that submits the API call. 
        // This is a permanent action and cannot be undone. No data will persist after removal.

        console.log("Trying to find desktop owned by: " + event.requestContext.authorizer.claims.email);

        var describeWorkspacesParams = [];

        workspaces.describeWorkspaces(describeWorkspacesParams, function (err, data) {
            if (err) {
                console.log(err, err.stack); // an error occurred
            } else {

                for (var i = 0; i < data.Workspaces.length; i++) {

                    var describeTagsParams = {
                        ResourceId: data.Workspaces[i].WorkspaceId /* required */
                    };
                    workspaces.describeTags(describeTagsParams, function (err, data) {
                        if (err) {
                            console.log(err, err.stack);
                        } else {

                            for (var i = 0; i < data.TagList.length; i++) {
                                if (data.TagList[i].Key == "SelfServiceManaged" && data.TagList[i].Value == event.requestContext.authorizer.claims.email) {
                                    console.log("Desktop for '" + event.requestContext.authorizer.claims.email + "' found: " + describeTagsParams.ResourceId);
                                    console.log("Deleting desktop '" + describeTagsParams.ResourceId + " per request.");

                                    var deletionParams = {
                                        TerminateWorkspaceRequests: [{
                                            WorkspaceId: describeTagsParams.ResourceId
                                        }]
                                    };

                                    console.log(JSON.stringify(deletionParams));

                                    workspaces.terminateWorkspaces(deletionParams, function (err, data) {
                                        if (err) {
                                            console.log("Error: " + err);
                                            callback(null, {
                                                statusCode: 500,
                                                body: JSON.stringify({
                                                    Error: err,
                                                }),
                                                headers: {
                                                    'Access-Control-Allow-Origin': '*',
                                                },
                                            });
                                        } else {
                                            console.log("Result: " + JSON.stringify(data));
                                            
                                            callback(null, {
                                                "statusCode": 200,
                                                "body": JSON.stringify({
                                                    Result: data
                                                }),
                                                "headers": {
                                                    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                                                    "Access-Control-Allow-Methods": "GET,OPTIONS",
                                                    "Access-Control-Allow-Origin": originURL
                                                }
                                            });
                                        }
                                    });

                                }
                            }

                        }
                    });
                }

            }
        });

    } else if (action == "bundles") {
        // 'bundles' handles returning the list of WorkSpaces bundles available to use. 
        // We must make the API call twice to return bundles owned by AMAZON and custom bundles.

        var bundleList = [];

        var bundleParams = {
            Owner: 'AMAZON'
          };
          workspaces.describeWorkspaceBundles(bundleParams, function(err, data) {

            if (err) {
                console.log("Error: " + err);
                callback(null, {
                    statusCode: 500,
                    body: JSON.stringify({
                        Error: err,
                    }),
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            } else {

                for (var i = 0; i < data["Bundles"].length ; i++ ) {
                    console.log(data["Bundles"][i].BundleId + ":" + data["Bundles"][i].Name);
                    bundleList.push(data["Bundles"][i].BundleId + ":" + data["Bundles"][i].Name);
                }
                
                callback(null, {
                    "statusCode": 200,
                    "body": JSON.stringify({
                        Result: bundleList
                    }),
                    "headers": {
                        "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                        "Access-Control-Allow-Methods": "GET,OPTIONS",
                        "Access-Control-Allow-Origin": originURL
                    }
                });
            }

          });

    } else {
        console.log("No action specified.");
        callback(null, {
            "statusCode": 500,
            "body": JSON.stringify({
                Error: "No action specified."
            }),
            "headers": {
                "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
                "Access-Control-Allow-Methods": "GET,OPTIONS",
                "Access-Control-Allow-Origin": originURL
            }
        });
    }

}